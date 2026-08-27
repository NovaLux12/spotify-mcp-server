import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { saveMiscStore } from '../src/tools/exhaust2_misc.js';
import { issueReceipt } from '../src/receipts.js';

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
function getHandler(toolName: string, client: ReturnType<typeof makeClient>): Handler {
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

function registrationNames(): string[] {
  const names: string[] = [];
  const server = { tool(name: string) { names.push(name); } } as unknown as McpServer;
  registerExhaust2MiscTools(server, makeClient());
  return names;
}

const PLAYED_NOW = (uri: string, name = 'Song') => ({
  played_at: new Date().toISOString(),
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
  it('morning_briefing renders digest sections from budgeted reads', async () => {
    const played = PLAYED_NOW('spotify:track:p1');
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
    console.error('DBG', JSON.stringify(res.structuredContent && (res.structuredContent as any).listening), res.content[0].text.split('\n').slice(0,12).join(' | '));assert.equal((res.structuredContent as { listening: { plays: number } }).listening.plays, 1);
  });

  // #403
  it('monthly_listening_report computes minutes, days and sessions for a month', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const h = getHandler('monthly_listening_report', makeClient({
      get: mock.fn(async (path: string) => {
        if (path.includes('recently-played')) {
          return {
            items: [PLAYED_NOW('spotify:track:a'), { ...PLAYED_NOW('spotify:track:a'), played_at: new Date(Date.now() - 60_000).toISOString() }],
            next: null,
          };
        }
        return null;
      }),
    }));
    const res = await h({ month, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Active days: 1'));
    assert.equal((res.structuredContent as { plays: number }).plays, 2);
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

  // #408
  it('dead_library_finder dry-runs unplayed, playlist-absent candidates', async () => {
    const h = getHandler('dead_library_finder', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path.startsWith('/me/tracks')) return [{ added_at: '2020-01-01T00:00:00Z', track: { uri: 'spotify:track:dead', name: 'Old' } }];
        if (path === '/me/playlists') return [{ id: 'p1', name: 'P' }];
        if (path.startsWith('/playlists/p1/items')) return [];
        return [];
      }),
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [] } : null)),
    }));
    const res = await h({ min_age_days: 30, dry_run: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('[dry run]'));
    assert.equal((res.structuredContent as { count: number }).count, 1);
  });

  // #409
  it('week_in_review_playlist plans, then creates and fills the weekly playlist', async () => {
    const client = makeClient({
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [PLAYED_NOW('spotify:track:w1')], next: null } : null)),
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
  it('playlist_staleness_report computes median age and 90d adds', async () => {
    const h = getHandler('playlist_staleness_report', makeClient({
      getAllPages: mock.fn(async (path: string) => {
        if (path === '/me/playlists') return [{ id: 'p1', name: 'Oldies' }];
        if (path.startsWith('/playlists/p1/items')) return [{ added_at: '2020-01-01T00:00:00Z' }, { added_at: new Date(Date.now() - 10 * 86400_000).toISOString() }];
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
      get: mock.fn(async (path: string) => {
        if (path.startsWith('/artists/aid/albums')) {
          return { name: 'Adele', items: [{ id: 'al1', name: '30', album_group: 'album', release_date: '2021' }, { id: 'al2', name: 'Missing EP', album_group: 'single', release_date: '2019' }] };
        }
        return null;
      }),
      getAllPages: mock.fn(async (path: string) => (path.startsWith('/me/albums') ? [{ album: { id: 'al1' } }] : [])),
    }));
    const res = await h({ artist_id: 'aid', include_singles: true, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('missing 1'));
    assert.ok(res.content[0].text.includes('Missing EP'));
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
  });

  // #422
  it('listening_week_in_time charts a past week inside the window', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const h = getHandler('listening_week_in_time', makeClient({
      get: mock.fn(async (path: string) => (path.includes('recently-played') ? { items: [PLAYED_NOW('spotify:track:x', 'Hit')] } : null)),
    }));
    const res = await h({ week_start: today, top_n: 5, response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Top tracks'));
    assert.ok(res.content[0].text.includes('Hit'));
  });

  it('listening_week_in_time refuses weeks older than the 90-day window', async () => {
    const old = new Date(Date.now() - 200 * 86400_000).toISOString().slice(0, 10);
    const h = getHandler('listening_week_in_time', makeClient());
    const res = await h({ week_start: old, response_format: 'concise' });
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

  // #424
  it('undo_preview reports an unknown receipt gracefully', async () => {
    const h = getHandler('undo_preview', makeClient());
    const res = await h({ mutation_id: 'rcpt_9999', response_format: 'concise' });
    assert.ok(res.content[0].text.includes('Unknown receipt'));
  });

  it('undo_preview diffs what a receipt-driven revert would do', async () => {
    const stub = { get: async () => ({ items: [{ item: { uri: 'spotify:track:a' } }], total: 1, next: null }) };
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

  // cleanup after all tests
  after(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
});
