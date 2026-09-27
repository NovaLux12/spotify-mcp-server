import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import { describe, it, mock, before, after, afterEach, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { saveMiscStore } from '../src/tools/exhaust2_misc.js';
import { classifyToolAnnotations } from '../src/tools/annotations.js';
import { ARTIST_ALBUM_PAGE_LIMIT } from '../src/tools/catalog.js';
import { finalInputSchema } from '../src/shaping.js';
import { StubSpotifyClient } from './helpers/stub-client.js';
import type { SpotifyClient } from '../src/client.js';
import { issueReceipt } from '../src/receipts.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Point every sidecar this slice touches at a throwaway temp dir.
const tmp = mkdtempSync(join(tmpdir(), 'exhaust2misc-'));
mkdirSync(join(tmp, 'history'), { recursive: true });
process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE = join(tmp, 'exhaust2-misc.json');
process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = join(tmp, 'genre-tags.json');
process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(tmp, 'playback-ext.json');
process.env.SPOTIFY_MCP_SCENES_FILE = join(tmp, 'scenes.json');
process.env.SPOTIFY_MCP_HISTORY_DIR = join(tmp, 'history');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    // The real SpotifyClient always sets this at construction; a stub that
    // omits it is not a client the stores can key by (#1385).
    tokenFile: DEFAULT_TOKEN_FILE,
    get: mock.fn(async () => null),
    getAllPages: mock.fn(async () => []),
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
    getRateLimitStatus: mock.fn(() => ({ cooldownRemainingMs: 0, lastThrottleAt: null, retryAfterSec: null })),
    ...overrides,
  } as unknown as import('../src/client.js').SpotifyClient;
}

/** Register and extract the handler for one tool by name. */
function getHandler(toolName: string, client: SpotifyClient): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(name: string, _desc: string, _shape: unknown, handler: Handler) {
      if (name === toolName) captured = handler;
    },
  } as unknown as McpServer;
  registerExhaust2MiscTools(server, client);
  assert.ok(captured, `tool ${toolName} not registered`);
  return captured;
}

/**
 * #1550: `dead_library_finder` now sits behind the shared elicitation gate for
 * a 10+ candidate removal. The gate resolves the host by probing the INNER
 * `server.server` for `elicitInput` / `getClientCapabilities` (#684), so a stub
 * shaped to pass that probe without a client ever being asked would let a dead
 * gate look green. `elicit: false` therefore omits the `server` key entirely —
 * the `unsupported` verdict, which must refuse.
 */
function getHandlerWithHost(
  toolName: string,
  client: SpotifyClient,
  elicit: false | { action: string; content?: Record<string, unknown> } | Error,
): { handler: Handler; prompts: () => number } {
  let captured: Handler | undefined;
  let prompts = 0;
  const server: Record<string, unknown> = {
    tool(name: string, _desc: string, _shape: unknown, handler: Handler) {
      if (name === toolName) captured = handler;
    },
  };
  if (elicit !== false) {
    server.server = {
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      async elicitInput() {
        prompts += 1;
        if (elicit instanceof Error) throw elicit;
        return elicit;
      },
    };
  }
  registerExhaust2MiscTools(server as unknown as McpServer, client);
  assert.ok(captured, `tool ${toolName} not registered`);
  return { handler: captured, prompts: () => prompts };
}

function registrationNames(): string[] {
  const names: string[] = [];
  const server = { tool(name: string) { names.push(name); } } as unknown as McpServer;
  registerExhaust2MiscTools(server, makeClient());
  return names;
}

/** Declared zod shape for every tool in the slice, keyed by tool name. */
function registrationShapes(): Map<string, Record<string, unknown>> {
  const shapes = new Map<string, Record<string, unknown>>();
  const server = {
    tool(name: string, _desc: string, shape: Record<string, unknown>) { shapes.set(name, shape); },
  } as unknown as McpServer;
  registerExhaust2MiscTools(server, makeClient());
  return shapes;
}

/**
 * Split a registrar source file into one text block per registered tool, so a
 * source-level rule (#827: a mutating tool must branch on `isDryRun(args)`) can
 * be asserted per tool instead of once for the whole file.
 *
 * Scoping per tool is what makes the rule STRONGER, not weaker: a whole-file
 * check is satisfied by a single `isDryRun(` anywhere in the module, so a
 * mutating tool that read the raw flag would still pass.
 */
function toolSourceBlocks(src: string): Array<[string, string]> {
  const starts: Array<{ name: string; at: number }> = [];
  const re = /server\.tool\(\s*\n?\s*'([a-z0-9_]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) starts.push({ name: m[1]!, at: m.index });
  return starts.map((s, i) => [
    s.name,
    src.slice(s.at, starts[i + 1]?.at ?? src.length),
  ]);
}

/**
 * The `dry_run` default a host actually reads off `tools/list` — the projected
 * JSON schema, not the zod internals, so this asserts the published contract.
 */
function publishedDryRunDefault(shape: Record<string, unknown> | undefined): unknown {
  const json = finalInputSchema(z.object(shape as Record<string, z.ZodType>)) as {
    properties?: Record<string, { default?: unknown }>;
  };
  return json.properties?.dry_run?.default;
}

/**
 * The instant every clock-sensitive test in this file runs at.
 *
 * It is deliberately mid-day and mid-month: the tools read the wall clock to
 * open a window (`morning_briefing` from local midnight to now,
 * `monthly_listening_report` across a whole UTC month), so a fixture stamped
 * "now" is one millisecond from falling out of its own window whenever the
 * suite happens to start near a UTC boundary. Pinning time is what makes the
 * answer the same at 00:00:30 UTC on the 1st of a month as it is at noon on
 * the 15th (#664).
 */
const PINNED_NOW = Date.parse('2026-06-15T18:00:00.000Z');

/**
 * A mid-day UTC play, inside `morning_briefing`'s "today" window under every
 * UTC offset (local midnight lands no later than 12:00Z, and no earlier than
 * 10:00Z) and strictly before the pinned clock, because `loadPlaysBetween`
 * takes an exclusive upper bound.
 */
const PINNED_PLAY = '2026-06-15T12:30:00.000Z';

/** Freeze the wall clock for one test. `t` restores it when the test ends. */
function pinClock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['Date'], now: PINNED_NOW });
}

/**
 * A recently-played row stamped at an explicit instant.
 *
 * The timestamp is a parameter, never `new Date()`. The tools in this slice
 * bucket by UTC day/month and filter on `played_at < Date.now()`, so a fixture
 * read off the real clock has its result decided by *when the suite started*
 * rather than by the behaviour under test (#664).
 */
const PLAYED_AT = (uri: string, playedAt: string, name = 'Song') => ({
  played_at: playedAt,
  track: { uri, name, duration_ms: 180_000, artists: [{ name: 'Adele' }] },
});

describe('exhaust2_misc — 27-tool misc slice', () => {
  it('registers exactly 27 tools with the expected names', () => {
    const names = registrationNames();
    assert.equal(names.length, 27);
    for (const expected of [
      'quick_save_now', 'morning_briefing', 'monthly_listening_report', 'year_in_review',
      'taste_checkpoint', 'taste_checkpoint_diff', 'discover_weekly_diff', 'dead_library_finder',
      'week_in_review_playlist', 'scope_audit', 'quota_probe', 'playlist_staleness_report',
      'show_backlog_report', 'audiobook_library_progress', 'chapter_bookmarks',
      'artist_complete_check', 'playlist_from_tags', 'listening_journal_append',
      'export_playlist_markdown', 'export_shows_opml', 'sidecar_export_bundle',
      'listening_week_in_time', 'mutation_log_export', 'undo_preview', 'receipt_lookup',
      'export_playlist_json', 'device_sync_state',
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  // #401
  it('quick_save_now plans a dry-run save of the current track', async () => {
    const h = getHandler('quick_save_now', makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me/player') return { item: { uri: 'spotify:track:t1', name: 'Hello' } };
        return null;
      }),
    }));
    const res = await h({ recent: 1, dry_run: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'));
    assert.ok(res.content[0].text.includes('Hello'));
    assert.equal((res.structuredContent as { uris: string[] }).uris[0], 'spotify:track:t1');
  });

  it('quick_save_now saves via PUT /me/library when dry_run=false', async () => {
    const put = mock.fn(async () => null);
    const h = getHandler('quick_save_now', makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me/player') return { item: { uri: 'spotify:track:t2', name: 'X' } };
        return null;
      }),
      put,
    }));
    const res = await h({ dry_run: false, response_format: 'concise' });
    assert.equal((res.structuredContent as { count: number }).count, 1);
    assert.equal(put.mock.callCount(), 1);
  });

  // #402
  it('morning_briefing renders digest sections from budgeted reads', async (t) => {
    pinClock(t);
    const played = PLAYED_AT('spotify:track:p1', PINNED_PLAY);
    const h = getHandler('morning_briefing', makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me/following') {
          return { artists: { items: [{ id: 'a1', name: 'Adele', genres: [] }], cursors: null, next: null } };
        }
        if (path.startsWith('/artists/a1/albums')) return { items: [] };
        if (path.includes('/episodes')) return { items: [] };
        if (path.includes('recently-played')) return { items: [played] };
        return null;
      }),
      getAllPages: mock.fn(async () => []),
    }));
    const res = await h({ include_listening: true, max_artists: 5, max_shows: 5, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Morning briefing'));
    assert.ok(res.content[0].text.includes('Today so far'));
    assert.equal((res.structuredContent as { listening: { plays: number } }).listening.plays, 1);
  });

  // #826 — a saved-show item carries `show.total_episodes`; the page envelope's
  // `total` is the saved-show count and never reaches the per-row read.
  it('morning_briefing reports the backlog from show.total_episodes', async () => {
    const h = getHandler('morning_briefing', makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me/following') return { artists: { items: [{ id: 'a1', name: 'Adele', genres: [] }], cursors: null, next: null } };
        if (path.startsWith('/artists/a1/albums')) return { items: [] };
        if (path.includes('/episodes')) return { items: [] };
        return null;
      }),
      // No envelope `total` — mirroring the real /me/shows item shape.
      getAllPages: mock.fn(async (path: string) => (path === '/me/shows'
        ? [{ show: { id: 'sh1', name: 'Long Runner', total_episodes: 412 } }]
        : [])),
    }));
    const res = await h({ include_listening: false, max_artists: 5, max_shows: 5, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Long Runner: 412 eps'), res.content[0].text);
    const backlog = (res.structuredContent as { show_backlog: Array<{ show: string; total_episodes: number | null }> }).show_backlog;
    assert.equal(backlog[0].total_episodes, 412);
  });

  // #403
  it('monthly_listening_report computes minutes, days and sessions for a month', async (t) => {
    pinClock(t);
    const h = getHandler('monthly_listening_report', makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('recently-played')) {
          return {
            items: [
              PLAYED_AT('spotify:track:a', '2026-06-15T12:00:00.000Z'),
              PLAYED_AT('spotify:track:a', '2026-06-15T11:59:00.000Z'),
            ],
            next: null,
          };
        }
        return null;
      }),
    }));
    const res = await h({ month: '2026-06', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Active days: 1'));
    assert.equal((res.structuredContent as { plays: number }).plays, 2);
  });

  // #664, suggested implementation 2: the UTC-month bucketing used to be
  // implied by a fixture that happened to sit inside the month. State it at
  // the boundary instead, so the behaviour is asserted rather than assumed —
  // and so the month-boundary window that used to make this file red is a
  // test that passes.
  it('monthly_listening_report buckets a play by its UTC month at a month boundary', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-01T00:00:30.000Z') });
    const client = makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('recently-played')) {
          // Newest first, the order the API returns: the cursor walk stops at
          // the first row older than the window it was asked for.
          return {
            items: [
              PLAYED_AT('spotify:track:sep', '2026-09-01T00:00:00.000Z'),
              PLAYED_AT('spotify:track:aug', '2026-08-31T23:59:00.000Z'),
            ],
            next: null,
          };
        }
        return null;
      }),
    });
    const h = getHandler('monthly_listening_report', client);
    const august = await h({ month: '2026-08', response_format: 'concise' });
    const september = await h({ month: '2026-09', response_format: 'concise' });
    assert.equal((august.structuredContent as { plays: number }).plays, 1, '23:59 on the 31st belongs to August');
    assert.equal((september.structuredContent as { plays: number }).plays, 1, '00:00 on the 1st belongs to September');
    assert.ok(august.content[0].text.includes('Active days: 1'));
    assert.ok(september.content[0].text.includes('Active days: 1'));
  });
  // #404
  it('year_in_review renders markdown review with tops and decade mix', async () => {
    const h = getHandler('year_in_review', makeClient({
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/me/top/tracks')) {
          return { items: [{ name: 'Rolling', artists: [{ name: 'Adele' }], album: { release_date: '2021-11-19' } }] };
        }
        if (path.startsWith('/me/top/artists')) {
          return { items: [{ name: 'Adele', genres: ['pop'] }] };
        }
        if (path.includes('recently-played')) return { items: [] };
        return null;
      }),
      getAllPages: mock.fn(async () => []),
    }));
    const res = await h({ year: 2026, output_format: 'markdown', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('# Year in review — 2026'));
    assert.ok(res.content[0].text.includes('Decade mix'));
  });

  // #405
  it('taste_checkpoint writes a dated sidecar slot', async () => {
    const h = getHandler('taste_checkpoint', makeClient({
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/me/top/tracks')) {
          return { items: [{ name: 'Rolling', uri: 'spotify:track:r1', artists: [{ name: 'Adele' }] }] };
        }
        if (path.startsWith('/me/top/artists')) return { items: [{ name: 'Adele', genres: ['pop'] }] };
        return null;
      }),
    }));
    const res = await h({ label: 'test-cp', time_range: 'medium_term', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('"test-cp" saved'));
    assert.ok(existsSync(process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE!));
  });

  // #406
  it('taste_checkpoint_diff diffs two slots with Jaccard — zero API calls', async () => {
    await saveMiscStore({
      checkpoints: {
        old: { label: 'old', saved_at: '2026-01-01', time_range: 'medium_term', artists: [{ name: 'Adele', genres: ['pop'] }], tracks: [{ name: 'A', artist_names: ['X'], uri: 'spotify:track:a' }, { name: 'B', artist_names: ['Y'], uri: 'spotify:track:b' }] },
        neu: { label: 'neu', saved_at: '2026-02-01', time_range: 'medium_term', artists: [{ name: 'Adele', genres: ['pop'] }], tracks: [{ name: 'A', artist_names: ['X'], uri: 'spotify:track:a' }, { name: 'C', artist_names: ['Z'], uri: 'spotify:track:c' }] },
      },
      bookmarks: {}, journal: [], reports: {},
    });
    const h = getHandler('taste_checkpoint_diff', makeClient());
    const res = await h({ from: 'old', to: 'neu', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('1 new'));
    assert.equal((res.structuredContent as { jaccard_tracks: number }).jaccard_tracks, 0.33);
  });

  // #407
  it('discover_weekly_diff flags new, overlapping and already-liked tracks', async () => {
    const h = getHandler('discover_weekly_diff', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path === '/me/playlists') return [{ id: 'dw', name: 'Discover Weekly' }, { id: 'arch', name: 'Discover Weekly Archive' }];
        if (path.startsWith('/playlists/dw/items')) return [{ item: { uri: 'spotify:track:1', name: 'N1', artists: [{ name: 'A' }] } }, { item: { uri: 'spotify:track:2', name: 'N2', artists: [{ name: 'B' }] } }];
        if (path.startsWith('/playlists/arch/items')) return [{ item: { uri: 'spotify:track:2', name: 'N2', artists: [{ name: 'B' }] } }];
        if (path.startsWith('/me/tracks')) return [{ track: { uri: 'spotify:track:1' } }];
        return [];
      }),
    }));
    const res = await h({ archive_name: 'Discover Weekly Archive', liked_cap: 500, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('New since archive: 1'));
    assert.ok(res.content[0].text.includes('Overlap with archive: 1'));
    assert.ok(res.content[0].text.includes('[liked]'));
  });

  // #827 — the archive sync is a PUT /playlists/{id}/items, which replaces the
  // playlist's whole item list. An omitted dry_run must preview, not commit.
  const WEEKLY_CLIENT = () => makeClient({
    getAllPages: mock.fn(async (path: string) => {
      if (path === '/me/playlists') return [{ id: 'dw', name: 'Discover Weekly' }, { id: 'arch', name: 'Discover Weekly Archive' }];
      if (path.startsWith('/playlists/dw/items')) return [{ item: { uri: 'spotify:track:1', name: 'N1', artists: [{ name: 'A' }] } }, { item: { uri: 'spotify:track:2', name: 'N2', artists: [{ name: 'B' }] } }];
      if (path.startsWith('/playlists/arch/items')) return [{ item: { uri: 'spotify:track:2', name: 'N2', artists: [{ name: 'B' }] } }];
      if (path.startsWith('/me/tracks')) return [{ track: { uri: 'spotify:track:1' } }];
      return [];
    }),
  });

  it('discover_weekly_diff previews the archive replace when dry_run is omitted', async () => {
    const client = WEEKLY_CLIENT();
    const h = getHandler('discover_weekly_diff', client);
    const res = await h({ archive_name: 'Discover Weekly Archive', liked_cap: 500, save_after: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'), res.content[0].text);
    assert.ok(res.content[0].text.includes('Discover Weekly Archive'), 'plan must name the playlist that would be replaced');
    assert.equal(res.structuredContent!.dry_run, true);
    assert.equal(client.put.mock.callCount(), 0, 'an omitted dry_run must not PUT /playlists/{id}/items');
    assert.equal(client.post.mock.callCount(), 0, 'an omitted dry_run must not POST /playlists/{id}/items');
  });

  it('discover_weekly_diff commits the archive replace only on dry_run: false', async () => {
    const client = WEEKLY_CLIENT();
    const h = getHandler('discover_weekly_diff', client);
    const res = await h({ archive_name: 'Discover Weekly Archive', liked_cap: 500, save_after: true, dry_run: false, response_format: 'concise' });
    assert.equal(res.structuredContent!.dry_run, false, 'a committed run must report dry_run: false');
    assert.equal(client.put.mock.callCount(), 1);
    assert.equal(client.put.mock.calls[0].arguments[0], '/playlists/arch/items');
    assert.deepEqual(client.put.mock.calls[0].arguments[1], { uris: ['spotify:track:1', 'spotify:track:2'] });
    assert.equal(client.post.mock.callCount(), 0, '2 tracks fit in one write, so no chunk follow-up');
  });

  it('every dry_run guard in the slice sits behind the shared default (#827)', () => {
    // Published contract: any MUTATING tool in this slice that exposes dry_run
    // says it defaults to true, so a host building a catalogue can tell
    // preview from commit without probing the handler.
    //
    // #896 scoped this to mutating tools. It used to be blanket, over every
    // tool exposing the flag — which meant a read-only scan report could only
    // ever be a preview, and the honest fix for that (`playlist_staleness_report`
    // gaining an opt-in cost preview, which is the shared `DryRunScan`
    // fragment) was unreachable. The exemption is not a hand-kept list: it is
    // the repo's own name-driven classifier, so a tool that later starts
    // writing cannot quietly inherit it.
    const shapes = registrationShapes();
    const flagged = [...shapes].filter(([, shape]) => 'dry_run' in shape).map(([name]) => name);
    assert.ok(flagged.length >= 7, `expected the mutating tools to expose dry_run, got ${flagged.join(', ')}`);
    const isReadOnly = (name: string): boolean => classifyToolAnnotations(name).readOnlyHint === true;
    const mutating = flagged.filter((name) => !isReadOnly(name));
    assert.ok(mutating.length >= 7, `expected the mutating tools to expose dry_run, got ${flagged.join(', ')}`);
    for (const name of mutating) {
      assert.equal(publishedDryRunDefault(shapes.get(name)), true, `${name} must publish dry_run default true`);
    }

    // And the source: no MUTATING tool's handler may read the raw optional
    // flag, and no tool may reach for the defaultless `DryRun` fragment. Both
    // are how an omitted flag turned into a commit. Scoped per tool block
    // rather than to the whole file, because a read-only scan preview must
    // branch on the raw `args.dry_run` — `isDryRun` defaults TRUE, which for a
    // report tool would mean it could only ever preview.
    const src = readFileSync(join(REPO_ROOT, 'src/tools/exhaust2_misc.ts'), 'utf8');
    for (const [name, block] of toolSourceBlocks(src)) {
      if (isReadOnly(name)) continue;
      if (!flagged.includes(name)) continue;
      assert.equal(/\bargs\.dry_run\b/.test(block), false, `${name} is mutating: a dry_run guard must go through isDryRun(args), not args.dry_run`);
      assert.equal(/\bisDryRun\(/.test(block), true, `${name} is mutating and exposes dry_run: it must branch on isDryRun(args)`);
    }
    assert.equal(/\bdry_run:\s*DryRun\s*,/.test(src), false, 'a mutating tool must not declare the defaultless DryRun fragment');
  });

  // #408 / #896
  it('dead_library_finder dry run reports the bound, not a scan it already performed', async () => {
    // #896: the dry run used to sit at the END of the handler, so it answered
    // `count` only by having already walked /me/tracks, 1000 recent plays and
    // 50 playlists x 500 items. `dry_run` DEFAULTS TO TRUE, so the
    // documented-safe path was the most expensive call in the module.
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/tracks')) return [{ added_at: '2020-01-01T00:00:00Z', track: { uri: 'spotify:track:dead', name: 'Old' } }];
        if (path === '/me/playlists') return [{ id: 'p1', name: 'P' }];
        if (path.startsWith('/playlists/p1/items')) return [];
        return [];
      }),
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [] } : null)),
    });
    const h = getHandler('dead_library_finder', client);
    const res = await h({ min_age_days: 30, dry_run: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'));
    // The preview must not have done the work it is previewing.
    assert.equal(client.getAllPages.mock.callCount(), 0, 'a dry run must not walk /me/tracks or /me/playlists');
    assert.equal(client.get.mock.callCount(), 0, 'a dry run must not walk recently-played');
    const sc = res.structuredContent as Record<string, unknown>;
    // Requirement 3: the candidate set is NOT knowable from the arguments, so
    // the preview says so. Reporting 0 would be the #803 class of lie.
    assert.equal(sc.count, null, 'an uncomputable preview must report null, not 0');
    assert.equal(sc.candidates_known, false);
    assert.ok(typeof sc.estimated_requests_max === 'number' && (sc.estimated_requests_max as number) > 0);
  });

  // #408
  it('dead_library_finder dry_run:false still performs the full scan', async () => {
    const client = makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/tracks')) return [{ added_at: '2020-01-01T00:00:00Z', track: { uri: 'spotify:track:dead', name: 'Old' } }];
        if (path === '/me/playlists') return [{ id: 'p1', name: 'P' }];
        if (path.startsWith('/playlists/p1/items')) return [];
        return [];
      }),
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [] } : null)),
    });
    const h = getHandler('dead_library_finder', client);
    const res = await h({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.ok(client.getAllPages.mock.callCount() > 0, 'the committing path must still scan');
    assert.equal((res.structuredContent as { count: number }).count, 1);
  });

  // #409
  it('week_in_review_playlist plans, then creates and fills the weekly playlist', async (t) => {
    // The tool reads the trailing 7 days as `[now - 7d, now)`; a fixture stamped
    // "now" is excluded by the exclusive bound and the playlist is built empty.
    pinClock(t);
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [PLAYED_AT('spotify:track:w1', PINNED_PLAY)], next: null } : null)),
      getAllPages: mock.fn(async (path: string) => (path === '/me/playlists' ? [] : [])),
      put: mock.fn(async () => null),
      post: mock.fn(async () => ({ id: 'newpl' })),
    });
    const plan = await getHandler('week_in_review_playlist', client)({ week_offset: 0, dry_run: true, response_format: 'concise' });
    assert.ok(plan.content[0].text.includes('[dry run]'));
    const done = await getHandler('week_in_review_playlist', client)({ week_offset: 0, dry_run: false, response_format: 'concise' });
    assert.ok(done.content[0].text.includes('ready'));
    assert.equal((done.structuredContent as { playlist_id: string }).playlist_id, 'newpl');
  });

  // #410
  it('scope_audit decodes scopes and classifies write modules', async () => {
    const h = getHandler('scope_audit', makeClient());
    const res = await h({ probe: false, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Scope audit'));
    assert.ok(Array.isArray((res.structuredContent as { granted_scopes: string[] }).granted_scopes));
    assert.ok(res.content[0].text.includes('Write-capable modules'));
  });

  // #411
  it('quota_probe reports per-endpoint status and rate-limit state', async () => {
    const h = getHandler('quota_probe', makeClient({
      get: mock.fn(async (path: string) => {
        if (path === '/me') return { id: 'me' };
        if (path === '/me/player') return { devices: [] };
        return null;
      }),
    }));
    const res = await h({ probe_set: 'light', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('/me/player: ok'));
    assert.ok(res.content[0].text.includes('Client rate-limit state'));
  });

  // #412
  it('playlist_staleness_report computes median age and 90d adds', async (t) => {
    pinClock(t);
    const h = getHandler('playlist_staleness_report', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path === '/me/playlists') return [{ id: 'p1', name: 'Oldies' }];
        // One ancient add and one exactly 10 days before the pinned clock, so
        // the "added last 90d" count is a property of the fixture, not of when
        // the suite happened to start.
        if (path.startsWith('/playlists/p1/items')) return [{ added_at: '2020-01-01T00:00:00Z' }, { added_at: '2026-06-05T18:00:00.000Z' }];
        return [];
      }),
    }));
    const res = await h({ limit: 10, sort: 'median_age', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Oldies'));
    assert.ok(res.content[0].text.includes('1 added last 90d'));
  });

  // #413
  it('show_backlog_report counts unplayed episodes and hours', async () => {
    const h = getHandler('show_backlog_report', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/shows')) return [{ show: { id: 's1', name: 'Pod', total_episodes: 2 } }];
        if (path.startsWith('/shows/s1/episodes')) {
          return [
            { name: 'E1', duration_ms: 3_600_000, release_date: '2026-08-01', resume_point: { fully_played: true } },
            { name: 'E2', duration_ms: 1_800_000, release_date: '2026-08-20' },
          ];
        }
        return [];
      }),
    }));
    const res = await h({ sort: 'backlog_hours', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Pod — 1 unplayed'));
  });

  // #414
  it('audiobook_library_progress reports percent complete', async () => {
    const h = getHandler('audiobook_library_progress', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/audiobooks')) return [{ audiobook: { id: 'ab1', name: 'Dune' } }];
        if (path.startsWith('/audiobooks/ab1/chapters')) {
          return [
            { name: 'C1', duration_ms: 3_600_000, resume_point: { fully_played: true } },
            { name: 'C2', duration_ms: 3_600_000 },
          ];
        }
        return [];
      }),
    }));
    const res = await h({ sort: 'progress', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Dune — 50%'));
  });

  // #415
  it('chapter_bookmarks saves and lists named positions (sidecar only)', async () => {
    const save = getHandler('chapter_bookmarks', makeClient());
    const r1 = await save({ op: 'save', book_uri: 'spotify:audiobook:1', label: 'Ch3', position_ms: 123_000, dry_run: false, response_format: 'concise' });
    assert.ok(r1.content[0].text.includes('saved'));
    const list = getHandler('chapter_bookmarks', makeClient());
    const r2 = await list({ op: 'list', book_uri: 'spotify:audiobook:1', response_format: 'concise' });
    assert.ok(r2.content[0].text.includes('Ch3'));
  });

  // #416
  it('artist_complete_check lists missing releases with breakdown', async () => {
    const h = getHandler('artist_complete_check', makeClient({
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/artists/aid/albums')
        ? [{ id: 'al1', name: '30', album_group: 'album', release_date: '2021' },
           { id: 'al2', name: 'Missing EP', album_group: 'single', release_date: '2019' }]
        : [{ album: { id: 'al1' } }])),
    }));
    const res = await h({ artist_id: 'aid', include_singles: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('missing 1'));
    assert.ok(res.content[0].text.includes('Missing EP'));
  });

  // #828 — the whole point is a catalogue larger than one page: a single-page
  // fixture would return the same numbers before and after the fix.
  it('artist_complete_check pages past the first page of an artist catalogue', async () => {
    const RELEASE_COUNT = 80; // 8 pages of 10; no single request can return this
    const ALL = Array.from({ length: RELEASE_COUNT }, (_, i) => ({
      id: `al${i}`, name: `Release ${i}`, album_group: i % 2 === 0 ? 'album' : 'single', release_date: '2020-01-01',
    }));
    const OWNED = new Set(ALL.slice(0, 30).map((a) => a.id));
    const albumRequests: Array<Record<string, string>> = [];

    // #659: this test carried the last hand-written paging loop in the suite,
    // with its own `?? 500` cap. It pages through a REAL StubSpotifyClient now,
    // so the walk that produced the 80 releases is the production one.
    const stub = new StubSpotifyClient();
    stub.route('GET', /.*/, {
      respond: (call) => {
        const params = call.arg as Record<string, string> | undefined;
        if (call.path.startsWith('/artists/aid/albums')) {
          albumRequests.push({ path: call.path, ...params });
          const limit = Number(params?.limit ?? 50);
          const offset = Number(params?.offset ?? 0);
          return {
            items: ALL.slice(offset, offset + limit),
            limit,
            offset,
            total: ALL.length,
          };
        }
        if (call.path === '/me/albums') {
          const limit = Number(params?.limit ?? 50);
          const offset = Number(params?.offset ?? 0);
          const saved = [...OWNED].map((id) => ({ album: { id } }));
          return { items: saved.slice(offset, offset + limit), total: saved.length, limit, offset };
        }
        return null;
      },
    });
    const h = getHandler('artist_complete_check', stub);

    const res = await h({ artist_id: 'aid', include_singles: true, response_format: 'concise' });
    const sc = res.structuredContent as { total_albums: number; missing: number; capped: boolean };
    assert.equal(sc.total_albums, RELEASE_COUNT, 'every release must be counted, not just page one');
    assert.equal(sc.missing, RELEASE_COUNT - OWNED.size);
    assert.equal(sc.capped, false);
    assert.ok(res.content[0].text.includes(`Catalog: ${RELEASE_COUNT} releases`));
    assert.ok(albumRequests.length >= RELEASE_COUNT / 10, `expected a page walk, saw ${albumRequests.length} request(s)`);
    for (const r of albumRequests) assert.equal(r.limit, String(ARTIST_ALBUM_PAGE_LIMIT), `page limit drifted: ${r.limit}`);
  });

  // #417
  it('playlist_from_tags matches tagged artists and previews the plan', async () => {
    writeFileSync(process.env.SPOTIFY_MCP_GENRE_TAGS_FILE!, `${JSON.stringify({ version: 1, tags: { Adele: ['pop'] } })}\n`);
    const h = getHandler('playlist_from_tags', makeClient({
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/me/tracks') ? [{ track: { uri: 'spotify:track:tp', name: 'Hello', artists: [{ name: 'Adele' }] } }] : [])),
    }));
    const res = await h({ tags: ['pop'], mode: 'create', dry_run: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'));
    assert.equal((res.structuredContent as { matches: number }).matches, 1);
  });

  // #1053 — playlist_from_tags is the fourth consumer of loadGenreTags. The
  // #759 contract is "throw on corruption, never coerce to empty", and the
  // existing three consumers (library_genre_report, filter_by_genre,
  // tag_management) honour it by letting the read's throw propagate. Pin the
  // same behaviour here so a future refactor cannot silently swallow it and
  // turn the sidecar into a one-entry stub on the next write.
  it('playlist_from_tags honours the #759 contract: corrupt sidecar throws and the file is preserved', async () => {
    const corrupt = '{not json';
    writeFileSync(process.env.SPOTIFY_MCP_GENRE_TAGS_FILE!, corrupt, 'utf8');
    const getAllPages = mock.fn(async () => []);
    const h = getHandler('playlist_from_tags', makeClient({ getAllPages }));
    await assert.rejects(
      h({ tags: ['pop'], mode: 'create', dry_run: true, response_format: 'concise' }),
      /is not valid JSON/,
    );
    // The hand-curated bytes are still on disk, byte for byte — the contract
    // never authorises a write to clobber them.
    assert.equal(readFileSync(process.env.SPOTIFY_MCP_GENRE_TAGS_FILE!, 'utf8'), corrupt);
    // And the corruption surfaces BEFORE the /me/tracks walk, so a corrupt
    // store never triggers a full library scan that ends up matching nothing.
    assert.equal(getAllPages.mock.callCount(), 0);
  });

  // #418
  it('listening_journal_append writes timestamped notes to the sidecar', async () => {
    const h = getHandler('listening_journal_append', makeClient());
    const res = await h({ note: 'focused session', tag: 'deepwork', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('focused session'));
    const raw = JSON.parse(readFileSync(process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE!, 'utf8'));
    assert.equal(raw.journal[0].tag, 'deepwork');
  });

  // #419
  it('export_playlist_markdown renders a paste-ready table', async () => {
    const h = getHandler('export_playlist_markdown', makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/playlists/pl') ? { name: 'MyList' } : null)),
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/playlists/pl/items') ? [{ item: { uri: 'spotify:track:1', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: '25' } }, added_at: '2026-01-01' }] : [])),
    }));
    const res = await h({ playlist_id: 'pl', include_added_at: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('| # | Track | Artists | Album | Added |'));
    assert.ok(res.content[0].text.includes('Hello'));
  });

  // #420
  it('export_shows_opml emits OPML with an honest RSS disclosure', async () => {
    const h = getHandler('export_shows_opml', makeClient({
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/me/shows') ? [{ show: { name: 'Pod', uri: 'spotify:show:1', publisher: 'P', external_urls: { spotify: 'https://open.spotify.com/show/1' } } }] : [])),
    }));
    const res = await h({ fetch_all: false, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('<opml version="2.0">'));
    assert.ok((res.structuredContent as { disclosure: string }).disclosure.includes('RSS feed URLs are not exposed'));
  });

  // #421
  it('sidecar_export_bundle bundles local state with a restore checklist', async () => {
    const h = getHandler('sidecar_export_bundle', makeClient());
    const res = await h({ pretty: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('"bundle_version": 1'));
    assert.ok(res.content[0].text.includes('restore_checklist'));
    assert.ok(!res.content[0].text.includes('unreadable_stores'), 'a clean export has nothing to report');
  });

  // #839: an unreadable store used to export as `null`, and the checklist then
  // told the user to write that `null` back over their file. The bundle is the
  // artefact a migration is run from, so a silent null there is the loss
  // archived as if it were the data.
  it('sidecar_export_bundle names a store it could not read and does not offer it for restore', async () => {
    const scenes = join(tmp, 'scenes.json');
    const truncated = '{"desk":{"volume":30';
    writeFileSync(scenes, truncated);
    try {
      const h = getHandler('sidecar_export_bundle', makeClient());
      const res = await h({ pretty: true, response_format: 'concise' });
      const bundle = JSON.parse(res.content[0].text) as {
        scenes: unknown;
        unreadable_stores?: Record<string, string>;
        restore_checklist: string[];
      };
      assert.equal(bundle.scenes, null);
      assert.match(bundle.unreadable_stores?.scenes ?? '', /is not valid JSON/);
      assert.match(bundle.unreadable_stores?.scenes ?? '', new RegExp(scenes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(bundle.restore_checklist[0]!, /Do NOT restore scenes/);
      assert.equal(readFileSync(scenes, 'utf8'), truncated, 'the file itself is left exactly as it was');
      assert.equal(readFileSync(`${scenes}.corrupt`, 'utf8'), truncated, 'and its bytes are preserved beside it');
    } finally {
      rmSync(scenes, { force: true });
      rmSync(`${scenes}.corrupt`, { force: true });
    }
  });

  // #422
  it('listening_week_in_time charts a past week inside the window', async (t) => {
    // The tool rejects a week more than 95 days back from *now*, so the window
    // edge is only a fixed distance if the clock is fixed too.
    pinClock(t);
    const h = getHandler('listening_week_in_time', makeClient({
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [PLAYED_AT('spotify:track:x', PINNED_PLAY, 'Hit')] } : null)),
    }));
    const res = await h({ week_start: '2026-06-15', top_n: 5, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Top tracks'));
    assert.ok(res.content[0].text.includes('Hit'));
  });

  it('listening_week_in_time refuses weeks older than the 90-day window', async (t) => {
    pinClock(t);
    const h = getHandler('listening_week_in_time', makeClient());
    const res = await h({ week_start: '2026-01-01', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('90-day'));
  });

  // #423
  it('mutation_log_export renders the JSONL history as markdown and csv', async () => {
    const lines = [
      `${JSON.stringify({ ts: '2026-08-01T10:00:00Z', who: 'agent', method: 'POST', path: '/playlists/p/items' })}`,
      `${JSON.stringify({ ts: '2026-08-20T10:00:00Z', who: 'agent', method: 'PUT', path: '/me/library' })}`,
      '',
    ].join('\n');
    writeFileSync(join(tmp, 'history', 'mutations.jsonl'), lines);
    const h = getHandler('mutation_log_export', makeClient());
    const md = await h({ from: '2026-08-10', format: 'markdown', response_format: 'concise' });
    assert.ok(md.content[0].text.includes('| PUT | /me/library |'));
    assert.ok(!md.content[0].text.includes('/playlists/p/items |'));
    const csv = await h({ format: 'csv', response_format: 'concise' });
    assert.ok(csv.content[0].text.startsWith('ts,who,method,path,snapshot_id'));
  });

  // #628: a huge ledger must not be loaded whole to render an audit table.
  it('mutation_log_export reports a bounded window for a 5,000-record ledger', async () => {
    const big = Array.from({ length: 5000 }, (_, i) =>
      JSON.stringify({ ts: new Date(Date.UTC(2026, 8, 1, 0, 0, i % 60, i)).toISOString(), who: 'agent', method: 'PUT', path: '/me/library' }),
    ).join('\n');
    writeFileSync(join(tmp, 'history', 'mutations.jsonl'), big + '\n');
    const h = getHandler('mutation_log_export', makeClient());
    const res = await h({ format: 'csv', response_format: 'concise' });
    const data = res.structuredContent as { total?: number; rows?: number };
    assert.equal(data.total, 500, 'reader caps the record window instead of loading all 5,000');
    assert.ok((res.content[0].text.match(/\n"/g) ?? []).length <= 500);
  });

  // #424
  it('undo_preview reports an unknown receipt gracefully, naming the session scope and the retention rule', async () => {
    const h = getHandler('undo_preview', makeClient());
    const res = await h({ mutation_id: 'rcpt_9999', response_format: 'concise' });
    assert.match(res.content[0].text, /Unknown or expired receipt "rcpt_9999"/);
    assert.match(res.content[0].text, /session-scoped/);
    assert.match(res.content[0].text, /100 most recent mutations/);
  });

  it('undo_preview diffs what a receipt-driven revert would do', async () => {
    // The receipt is filed under the same account the handler reads it back
    // under, so both sides have to name one (#1385).
    const stub = {
      tokenFile: DEFAULT_TOKEN_FILE,
      get: async () => ({ items: [{ item: { uri: 'spotify:track:a' } }], total: 1, next: null }),
    };
    const receipt = await issueReceipt(stub as never, { kind: 'playlist_items', id: 'p1', uris: ['spotify:track:a'] });
    const h = getHandler('undo_preview', makeClient());
    const res = await h({ mutation_id: receipt.receipt_id, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'));
    assert.ok(res.content[0].text.includes('DELETE /playlists/p1/items'));
  });
  // #425
  it('receipt_lookup filters receipts by affected URI', async () => {
    const h = getHandler('receipt_lookup', makeClient());
    const res = await h({ uri: 'spotify:track:a', response_format: 'concise' });
    assert.ok((res.structuredContent as { matches: number }).matches >= 1);
  });

  // #587 — `since` reads the receipt's issue time. Before, it compared the
  // DIGITS in the id, so a boot-scoped id or a past date matched nothing.
  it('receipt_lookup filters by issue time, not by the digits in the receipt id', async () => {
    const receipt = await issueReceipt({ tokenFile: DEFAULT_TOKEN_FILE, get: async () => [true] } as never, {
      kind: 'library',
      uris: ['spotify:track:since-filter'],
    });
    const h = getHandler('receipt_lookup', makeClient());

    const past = await h({ since: '2000-01-01', response_format: 'concise' });
    assert.ok(
      (past.structuredContent as { matches: number }).matches >= 1,
      'a date before the mutation keeps its receipts',
    );

    const future = await h({ since: '2999-01-01', response_format: 'concise' });
    const futureData = future.structuredContent as { matches: number; receipts: Array<{ receipt_id: string }> };
    assert.equal(futureData.matches, 0, 'a date after every mutation drops them all');

    const mine = await h({ id: receipt.receipt_id, response_format: 'concise' });
    const row = (mine.structuredContent as { receipts: Array<{ issued_at: number | null }> }).receipts[0]!;
    assert.equal(typeof row.issued_at, 'number', 'a receipt reports when it was issued');
    assert.ok(row.issued_at! <= Date.now() && row.issued_at! > 0);
  });

  // #426
  it('export_playlist_json exports full fidelity items', async () => {
    const h = getHandler('export_playlist_json', makeClient({
      get: mock.fn(async (path: string) => (path.startsWith('/playlists/pl') ? { name: 'MyList', owner: { id: 'me' }, uri: 'spotify:playlist:pl', tracks: { total: 1 } } : null)),
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/playlists/pl/items') ? [{ item: { uri: 'spotify:track:1', name: 'Hello', artists: [{ name: 'Adele' }], album: { name: '25' }, duration_ms: 200_000 }, added_at: '2026-01-01T00:00:00Z', added_by: { id: 'me' } }] : [])),
    }));
    const res = await h({ playlist_id: 'pl', response_format: 'concise' });
    const text = res.content[0].text;
    assert.ok(text.includes('"added_by": "me"'));
    assert.ok(text.includes('"total_tracks": 1'));
  });

  // #427
  it('device_sync_state flags dead sidecar presets and prunes them', async () => {
    writeFileSync(process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE!, `${JSON.stringify({ states: {}, devicePresets: { Ghost: { volume: 30 } }, sessions: {}, smartRules: {} })}\n`);
    writeFileSync(process.env.SPOTIFY_MCP_SCENES_FILE!, `${JSON.stringify({ Focus: { device_hint: 'Speaker', volume: 40 } })}\n`);
    const client = makeClient({
      get: mock.fn(async (path: string) => (path === '/me/player/devices' ? { devices: [{ id: 'd1', name: 'Speaker', type: 'speaker' }] } : null)),
    });
    const plan = await getHandler('device_sync_state', client)({ prune: true, dry_run: true, response_format: 'concise' });
    assert.ok(plan.content[0].text.includes('Ghost'));
    const pruned = await getHandler('device_sync_state', client)({ prune: true, dry_run: false, response_format: 'concise' });
    assert.ok(pruned.content[0].text.includes('Pruned 1 dead preset'));
    const ext = JSON.parse(readFileSync(process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE!, 'utf8'));
    assert.equal(Object.keys(ext.devicePresets).length, 0);
  });

  // #1070: device_sync_state must read scenes and playback-ext independently.
  // A corrupt scenes.json used to take down the whole tool and the caller
  // was told nothing about which store failed. The fix surfaces scenes
  // corruption as `load_error` on the response (same shape as the
  // playback-ext #839 surfacing) and the playback-ext half keeps running.
  it('device_sync_state surfaces scenes corruption as load_error and still reconciles presets (#1070)', async () => {
    writeFileSync(process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE!, `${JSON.stringify({ states: {}, devicePresets: { Ghost: { volume: 30 } }, sessions: {}, smartRules: {} })}\n`);
    writeFileSync(process.env.SPOTIFY_MCP_SCENES_FILE!, '{"Fresh": {oops', 'utf8');
    const client = makeClient({
      get: mock.fn(async (path: string) => (path === '/me/player/devices' ? { devices: [{ id: 'd1', name: 'Speaker', type: 'speaker' }] } : null)),
    });
    const plan = await getHandler('device_sync_state', client)({ prune: true, dry_run: true, response_format: 'concise' });

    // Tool did NOT throw (assertion = no exception bubbled past `await`).
    const text = plan.content[0].text;
    const echo = plan.structuredContent as Record<string, unknown>;

    // Prose carries the warning so a human reader sees it before the plan.
    assert.match(text, /^WARNING: scenes\.json was unreadable/);
    assert.match(text, /Ghost/, 'playbackext half still reports the dead preset');

    // structuredContent surfaces load_error AND the playbackext result.
    assert.equal(typeof echo.load_error, 'string', 'load_error is required on the response');
    assert.match(echo.load_error as string, /scenes\.json was unreadable/);
    assert.match(echo.load_error as string, /it was not loaded/);
    assert.deepEqual(echo.dead_scene_hints, [], 'no scenes processed when the sidecar is unreadable');
    assert.deepEqual(echo.dead_presets, ['Ghost'], 'playback-ext half still reconciles presets');
    assert.ok(Array.isArray(echo.live_devices));
    assert.equal((echo.live_devices as Array<{ name: string }>)[0]!.name, 'Speaker');

    // dry_run=true must NOT have written either sidecar: the scenes file is
    // still corrupt and the playback-ext file is unchanged.
    assert.match(readFileSync(process.env.SPOTIFY_MCP_SCENES_FILE!, 'utf8'), /\{oops/);
    const ext = JSON.parse(readFileSync(process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE!, 'utf8'));
    assert.ok(ext.devicePresets.Ghost, 'Ghost is still in playback-ext until prune=true,dry_run=false');

    // prune=true,dry_run=false still prunes the playback-ext sidecar and
    // surfaces the scenes failure on the same response.
    const pruned = await getHandler('device_sync_state', client)({ prune: true, dry_run: false, response_format: 'concise' });
    const prunedEcho = pruned.structuredContent as Record<string, unknown>;
    assert.match(pruned.content[0].text, /^WARNING: scenes\.json was unreadable/);
    assert.match(pruned.content[0].text, /Pruned 1 dead preset/);
    assert.equal(typeof prunedEcho.load_error, 'string');
    assert.equal(prunedEcho.pruned, true);
    assert.deepEqual(prunedEcho.dead_presets, ['Ghost']);
    const extAfter = JSON.parse(readFileSync(process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE!, 'utf8'));
    assert.equal(Object.keys(extAfter.devicePresets).length, 0, 'playback-ext sidecar was pruned');
    // The corrupt scenes file is left in place — we never had a SceneStore to
    // save, so a save would have destroyed the original bytes. The caller is
    // told it is unreadable via load_error, exactly the contract.
    assert.match(readFileSync(process.env.SPOTIFY_MCP_SCENES_FILE!, 'utf8'), /\{oops/);
  });

  // cleanup after all tests
  // #1051: a corrupt slice sidecar must NOT silently read as an empty store,
  // or the next mutating call would overwrite the user's hand-curated state
  // (checkpoints / bookmarks / journal) with a default-shaped stub. The
  // bytes survive at <path>.corrupt and the tool errors out so the caller
  // can decide whether to repair or stop.
  it('#1051 corrupt misc sidecar: tool throws and bytes are preserved', async () => {
    const file = process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE!;
    const corrupt = '{oops';
    writeFileSync(file, corrupt, 'utf8');
    const h = getHandler('taste_checkpoint', makeClient({
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/me/top/tracks')) return { items: [] };
        if (path.startsWith('/me/top/artists')) return { items: [] };
        return null;
      }),
    }));
    await assert.rejects(
      h({ label: 'should-never-save', time_range: 'medium_term', response_format: 'concise' }),
      /is not valid JSON/,
    );
    assert.equal(readFileSync(`${file}.corrupt`, 'utf8'), corrupt, 'preserved copy must be byte-identical');
    assert.equal(readFileSync(file, 'utf8'), corrupt, 'original must remain on disk');
  });

  it('#1051 corrupt misc sidecar: missing array shape throws (not silently coerced)', async () => {
    const file = process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE!;
    writeFileSync(file, JSON.stringify({ checkpoints: {}, bookmarks: {}, journal: 'oops', reports: {} }), 'utf8');
    const h = getHandler('listening_journal_append', makeClient());
    await assert.rejects(
      h({ note: 'never written', response_format: 'concise' }),
      /"journal" is not an array/,
    );
  });

  // cleanup after all tests
  after(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // #1084: a pre-existing exhaust2-misc.json that was copied in with a
  // world-readable mode must be tightened to 0600 when saveMiscStore writes
  // through it.
  it('tightens a world-readable pre-existing exhaust2-misc.json to 0600 (#1084)', async () => {
    const file = process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE!;
    writeFileSync(file, JSON.stringify({ checkpoints: {}, bookmarks: {}, journal: [], reports: {} }));
    chmodSync(file, 0o644);
    await saveMiscStore({ checkpoints: { k: { value: 1, captured_at: '2026-01-01T00:00:00Z', context: 'c', source: 's' } }, bookmarks: {}, journal: [], reports: {} });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});

// ---------------------------------------------------------------------------
// #1550 — `dead_library_finder` gates a 10+ candidate removal
//
// The preview default here was already correct (#827). The missing half was
// the gate: the candidate set is the whole dead-track sweep, uncapped, so a
// single `dry_run:false` could unsave a library wholesale. Assertions are on
// the stub's own `delete` log — "nothing was removed" must be observed, not
// read off a message.
// ---------------------------------------------------------------------------

describe('#1550 dead_library_finder gates bulk removal at the family threshold', () => {
  /** A library with `n` long-unsaved, unplayed, playlist-free tracks. */
  function libraryOf(n: number) {
    return makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/tracks')) {
          return Array.from({ length: n }, (_, i) => ({
            added_at: '2020-01-01T00:00:00Z',
            track: { uri: `spotify:track:dead${i}`, name: `Dead ${i}` },
          }));
        }
        if (path === '/me/playlists') return [{ id: 'p1', name: 'P' }];
        if (path.startsWith('/playlists/p1/items')) return [];
        return [];
      }),
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [] } : null)),
    });
  }
  const deletes = (c: SpotifyClient) =>
    (c.delete as unknown as { mock: { calls: Array<{ arguments: [string] }> } }).mock.calls;
  const reasonOf = (res: { structuredContent?: Record<string, unknown> }) =>
    (res.structuredContent as { reason?: string } | undefined)?.reason;

  afterEach(() => {
    delete process.env.SPOTIFY_MCP_CONFIRM;
  });

  it('an OMITTED dry_run deletes nothing', async () => {
    // The preview default was already correct, but the omitted case is the one
    // that must be asserted rather than assumed.
    const client = libraryOf(12);
    const { handler } = getHandlerWithHost('dead_library_finder', client, false);
    const res = await handler({ min_age_days: 30, response_format: 'concise' });
    assert.equal(deletes(client).length, 0, 'an omitted flag must preview, not remove');
    assert.equal(res.structuredContent?.dry_run, true);
  });

  it('10+ candidates with a client that cannot prompt REFUSE with zero deletes', async () => {
    const client = libraryOf(12);
    const { handler } = getHandlerWithHost('dead_library_finder', client, false);
    const res = await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(deletes(client).length, 0, 'an unpromptable client must not become an unprompted delete');
    assert.equal(reasonOf(res), 'confirmation_unavailable');
  });

  it('a DECLINED prompt refuses with zero deletes', async () => {
    const client = libraryOf(12);
    const { handler, prompts } = getHandlerWithHost('dead_library_finder', client, { action: 'decline' });
    const res = await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(prompts(), 1, 'the gate must actually have asked');
    assert.equal(deletes(client).length, 0);
    assert.equal((res.structuredContent as { cancelled?: boolean }).cancelled, true);
  });

  it('a prompt that FAILS mid-flight refuses with zero deletes', async () => {
    // #684: a gate that throws must not degrade into an ungated write.
    const client = libraryOf(12);
    const { handler } = getHandlerWithHost('dead_library_finder', client, new Error('elicitation exploded mid-flight'));
    const res = await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(deletes(client).length, 0);
    assert.equal(reasonOf(res), 'elicitation_failed');
  });

  it('an accepted prompt at 12 candidates commits', async () => {
    const client = libraryOf(12);
    const { handler, prompts } = getHandlerWithHost('dead_library_finder', client, { action: 'accept', content: { confirm: true } });
    await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(prompts(), 1);
    assert.ok(deletes(client).length > 0, 'an accepted removal must actually reach DELETE');
  });

  it('9 candidates commits without asking — the gate starts at 10', async () => {
    const client = libraryOf(9);
    const { handler, prompts } = getHandlerWithHost('dead_library_finder', client, false);
    await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(prompts(), 0, 'nothing below REMOVE_ELICIT_THRESHOLD may prompt');
    assert.ok(deletes(client).length > 0);
  });

  it('the prompt names the operation and the number of tracks at stake', async () => {
    const messages: string[] = [];
    const client = libraryOf(12);
    let captured: Handler | undefined;
    const server = {
      tool(name: string, _d: string, _s: unknown, h: Handler) { if (name === 'dead_library_finder') captured = h; },
      server: {
        getClientCapabilities: () => ({ elicitation: { form: {} } }),
        async elicitInput(params: { message?: string }) { messages.push(params?.message ?? ''); return { action: 'accept', content: { confirm: true } }; },
      },
    } as unknown as McpServer;
    registerExhaust2MiscTools(server, client);
    assert.ok(captured);
    await captured({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(messages.length, 1);
    // Asserted against the line `describeConfirmation` actually builds, which is
    // `About to <kind> "<target>":` — the operation and the count are both in
    // `kind`, so one assertion covers what the test is named for.
    assert.match(messages[0], /unsave 12 dead track\(s\) from your saved library/i);
    // The preview is capped at 10 rows, so the remainder has to be disclosed
    // rather than silently dropped — that is what makes 12 readable as 12.
    assert.match(messages[0], /and 2 more/);
  });

  it('SPOTIFY_MCP_CONFIRM=never bypasses the prompt, never the preview default', async () => {
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const committing = libraryOf(12);
    const { prompts } = getHandlerWithHost('dead_library_finder', committing, false);
    const { handler } = getHandlerWithHost('dead_library_finder', committing, false);
    await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
    assert.equal(prompts(), 0);
    assert.ok(deletes(committing).length > 0, 'the documented automation bypass must be honoured');

    const preview = libraryOf(12);
    const p2 = getHandlerWithHost('dead_library_finder', preview, false);
    await p2.handler({ min_age_days: 30, response_format: 'concise' });
    assert.equal(deletes(preview).length, 0, 'the bypass removes the PROMPT, never the dry-run default');
  });

  for (const value of ['NEVER', 'Never', 'no', 'false', '1', 'true', ' ']) {
    it(`SPOTIFY_MCP_CONFIRM=${JSON.stringify(value)} does NOT bypass the gate`, async () => {
      process.env.SPOTIFY_MCP_CONFIRM = value;
      const client = libraryOf(12);
      const { handler } = getHandlerWithHost('dead_library_finder', client, false);
      const res = await handler({ min_age_days: 30, dry_run: false, response_format: 'concise' });
      assert.equal(
        deletes(client).length,
        0,
        `SPOTIFY_MCP_CONFIRM=${JSON.stringify(value)} must not act as a bypass`,
      );
      assert.equal(reasonOf(res), 'confirmation_unavailable');
    });
  }

  it('the published shape declares default: true for dry_run', () => {
    const shape = registrationShapes().get('dead_library_finder')!;
    assert.equal((shape.dry_run as { _def?: { defaultValue?: unknown } })._def?.defaultValue, true);
  });
});
