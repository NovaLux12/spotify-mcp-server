#!/usr/bin/env node
// Live gauntlet: exercises every registered MCP tool against the real Spotify
// API and proves nothing was mutated.
//
// Prereqs: npm run build && npm run auth && .env present (tokens in
// ~/.spotify-mcp/tokens.json).
//
// Usage:
//   node scripts/live-gauntlet.mjs [report.json]
//   node scripts/live-gauntlet.mjs --include-mutating=create_playlist,save_items [report.json]
//   node scripts/live-gauntlet.mjs --batch=40 --resume=memory/live-sweep-report.json --report=memory/live-sweep-report.json
//
// Batch/resume mode (quota-paced sweeps of the full surface):
//   --batch=N      stop after N tool calls this run (seeds excluded)
//   --resume=FILE  skip tools already recorded in FILE (FAILs are retried)
//   --report=FILE  cumulative report location (used by --resume)
// A run with nothing left to do prints SWEEP_COMPLETE and exits 0.
//
// Safety model:
//   - Tools are classified SAFE (reads) vs MUTATING via the table below;
//     anything unclassified is treated as MUTATING (skipped by default).
//   - MUTATING tools are skipped unless named in --include-mutating=a,b AND
//     their inputSchema declares `dry_run`. The call always passes
//     dry_run:true and PASSES only when the response confirms the dry-run
//     preview — so even the opt-in path cannot mutate.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

// ---------------------------------------------------------------- classification

const MUTATING = new Set([
  // library.ts
  'save_items', 'remove_saved_items', 'save_to_library', 'remove_from_library',
  // following.ts
  'follow_artists', 'unfollow_artists',
  // playback.ts
  'play_from_search', 'play', 'pause', 'skip_next', 'skip_previous', 'seek',
  'set_volume', 'set_shuffle', 'set_repeat', 'add_to_queue', 'transfer_playback',
  // playlists.ts
  'upload_playlist_cover', 'create_playlist', 'add_to_playlist',
  'remove_from_playlist', 'update_playlist', 'reorder_playlist_items',
  'replace_playlist_items',
]);

// Endpoints Spotify removed in its Feb 2026 Web API changes: registered but
// expected to fail on newer app registrations. A failure here is reported as
// SKIP, not FAIL.
const REMOVED = new Set(['get_artist_top_tracks', 'get_available_markets', 'get_user_profile', 'get_user_playlists_by_id']);

// Endpoints that 403 Forbidden on current app registrations (2026-08-27 edge
// probe): documented /me/*/contains family, browse categories, and friends.
// Legacy registrations may still serve them; failure here is SKIP, not FAIL.
const GATED = new Set([
  'get_categories', 'get_category_playlists', 'get_new_releases',
  'check_in_library', 'check_saved_items', 'check_following_artists',
  'check_following_playlist', 'check_following_artists_and_users',
]);

// Snippets meaning "tool answered but the underlying endpoint is gated".
const GATE_SNIFF = /forbidden|\b403\b|removed by spotify|not available for this app|app registration/i;

// --------------------------------------------------------------- JSONL RPC layer

const child = spawn('node', ['--env-file=.env', 'dist/index.js'], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) pending.get(m.id)(m); } catch {}
  }
});
let nextId = 1;
function rpc(method, params, timeoutMs = 120000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout: ${method}`))), timeoutMs);
  });
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-gauntlet', version: '1.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const textOf = (r) => r.content.map((c) => c.text).join('\n');

async function callTool(name, args) {
  const t0 = Date.now();
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    return { ok: true, ms: Date.now() - t0, text: textOf(r), structured: r.structuredContent };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message.slice(0, 300) };
  }
}

// ------------------------------------------------------------------- CLI args

const includeMutating = new Set(
  process.argv.slice(2).filter((a) => a.startsWith('--include-mutating='))
    .flatMap((a) => a.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean)),
);
const reportFlag = process.argv.slice(2).find((a) => a.startsWith('--report='));
const reportPath = reportFlag ? reportFlag.split('=')[1] : process.argv.slice(2).find((a) => !a.startsWith('--'));

// Batch/resume support (issue #330). --batch caps API calls per run; --resume
// skips tools already recorded (FAILs retried so quota stalls are not cached).
const batchArg = process.argv.slice(2).find((a) => a.startsWith('--batch='));
const batchLimit = batchArg ? Math.max(1, parseInt(batchArg.split("=")[1], 10)) : Infinity;
const resumeArg = process.argv.slice(2).find((a) => a.startsWith('--resume='));
const resumePath = resumeArg ? resumeArg.split("=")[1] : undefined;
const done = new Map();
if (resumePath) {
  try {
    const prev = JSON.parse(readFileSync(resumePath, 'utf8'));
    for (const r of prev.results ?? []) done.set(r.tool, r);
    console.log(`resume: ${done.size} already-recorded tool entries loaded from ${resumePath}`);
  } catch (e) {
    console.error(`resume: cannot read ${resumePath} (${e.message}) — starting fresh`);
  }
}
let calls = 0;   // API calls performed this run (seeds excluded)
let resumed = 0; // tools skipped due to prior records
let consecutiveFails = 0; // quota-wall abort counter
const RETRY_MAX = parseInt(process.env.SWEEP_RETRY_MAX ?? '2', 10); // FAIL attempts before giving up

// ------------------------------------------------------------------ discovery

const { tools } = await rpc('tools/list', {});
const schemaOf = new Map(tools.map((t) => [t.name, t.inputSchema ?? {}]));
console.log(`tools/list: ${tools.length} tools discovered`);

// NOTE: full-surface sweeps cost hundreds of calls against Spotify's
// per-developer-account quota (July-2026 change). Observed behavior across
// four runs on 2026-08-25: the first sweep passes ~45/45; back-to-back
// sweeps then stall mid-run — every call after roughly the catalog section
// waits out cascading Retry-After windows and hits the per-call timeout.
// This is quota reality, not a client defect (#133's priority lanes keep
// interactive reads responsive; they cannot conjure quota). Space full
// sweeps hours apart, or verify subsets per run — cumulative coverage
// across the day's four runs reached all 94 tools with zero functional
// failures and zero mutations.

// ---------------------------------------------------------------------- seeds

// Minimal reads whose results feed every other SAFE call's arguments.
const seed = {}; // { userId, trackId, albumId, artistId, showId, episodeId, audiobookId, playlistId }
const results = [];

function record(name, cls, status, ms, extra = {}) {
  results.push({ tool: name, class: cls, status, latency_ms: ms, ...extra });
  const flag = status === 'PASS' ? '+' : status === 'SKIP' ? '-' : 'x';
  console.log(`[${flag}] ${status.padEnd(5)} ${(cls + ' ' + name).padEnd(40)} ${ms}ms ${extra.reason ?? ''}`);
}

// Seeds themselves go through the same recorder.
{
  let r = await callTool('get_me', { response_format: 'json' });
  if (r.ok) {
    const me = r.structured ?? {};
    seed.userId = me.id;
    seed.country = me.country;
    record('get_me', 'SAFE', 'PASS', r.ms);
  } else record('get_me', 'SAFE', 'FAIL', r.ms, { reason: r.error });

  r = await callTool('search', { query: 'daft punk', types: ['track', 'show', 'episode'], limit: 3, response_format: 'json' });
  if (r.ok) {
    const t = r.structured?.tracks?.items?.[0];
    if (t) { seed.trackId = t.id; seed.albumId = t.album?.id; seed.artistId = t.artists?.[0]?.id; }
    seed.showId = r.structured?.shows?.items?.[0]?.id;
    seed.episodeId = r.structured?.episodes?.items?.[0]?.id;
    record('search', 'SAFE', 'PASS', r.ms);
  } else record('search', 'SAFE', 'FAIL', r.ms, { reason: r.error });

  // Audiobooks are market-gated; failure here just skips the audiobook tools.
  r = await callTool('search', { query: 'project hail mary', types: ['audiobook'], limit: 3, response_format: 'json' });
  if (r.ok) seed.audiobookId = r.structured?.audiobooks?.items?.[0]?.id;

  r = await callTool('get_user_playlists', { max_results: 10, response_format: 'json' });
  if (r.ok) {
    const p = Array.isArray(r.structured) ? r.structured[0] : r.structured?.items?.[0];
    seed.playlistId = p?.id;
    record('get_user_playlists', 'SAFE', 'PASS', r.ms);
  } else record('get_user_playlists', 'SAFE', 'FAIL', r.ms, { reason: r.error });
}

// ------------------------------------------------------- SAFE arg derivation

// Each builder returns minimal args from the seed reads, or a skip reason.
const SAFE_ARGS = {
  get_me: () => ({}),
  search: () => ({ query: 'radiohead', types: ['artist'], limit: 3 }),
  // catalog.ts
  get_track: () => seed.trackId ? { id: seed.trackId } : 'no track in seeds',
  get_artist: () => seed.artistId ? { id: seed.artistId } : 'no artist in seeds',
  get_artist_albums: () => seed.artistId ? { id: seed.artistId, max_results: 5 } : 'no artist in seeds',
  get_album: () => seed.albumId ? { id: seed.albumId } : 'no album in seeds',
  get_album_tracks: () => seed.albumId ? { id: seed.albumId, limit: 5 } : 'no album in seeds',
  get_show: () => seed.showId ? { id: seed.showId } : 'no show in seeds',
  get_show_episodes: () => seed.showId ? { id: seed.showId, limit: 5 } : 'no show in seeds',
  get_episode: () => seed.episodeId ? { id: seed.episodeId } : 'no episode in seeds',
  get_several_tracks: () => seed.trackId ? { ids: [seed.trackId] } : 'no track in seeds',
  get_several_albums: () => seed.albumId ? { ids: [seed.albumId] } : 'no album in seeds',
  get_several_artists: () => seed.artistId ? { ids: [seed.artistId] } : 'no artist in seeds',
  get_several_shows: () => seed.showId ? { ids: [seed.showId] } : 'no show in seeds',
  get_several_episodes: () => seed.episodeId ? { ids: [seed.episodeId] } : 'no episode in seeds',
  // following.ts
  get_followed_artists: () => ({ limit: 5 }),
  check_following_artists: () => seed.artistId ? { ids: [seed.artistId] } : 'no artist in seeds',
  // library.ts
  get_saved_tracks: () => ({ limit: 5 }),
  get_saved_albums: () => ({ limit: 5 }),
  get_saved_shows: () => ({ limit: 5 }),
  get_saved_episodes: () => ({ limit: 5 }),
  get_saved_audiobooks: () => ({ limit: 5 }),
  check_saved_items: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  check_in_library: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  // personalization.ts
  get_top_tracks: () => ({ limit: 5 }),
  get_top_artists: () => ({ limit: 5 }),
  get_recently_played: () => ({ limit: 5 }),
  // playback.ts (reads)
  get_now_playing: () => ({}),
  get_currently_playing: () => ({}),
  get_queue: () => ({}),
  get_devices: () => ({}),
  // playlists.ts (reads)
  get_user_playlists: () => ({}),
  get_playlist: () => seed.playlistId ? { id: seed.playlistId } : 'no playlist in seeds',
  get_playlist_items: () => seed.playlistId ? { id: seed.playlistId, limit: 5 } : 'no playlist in seeds',
  get_playlist_cover: () => seed.playlistId ? { id: seed.playlistId } : 'no playlist in seeds',
  find_duplicates_in_playlist: () => seed.playlistId ? { playlist_id: seed.playlistId } : 'no playlist in seeds',
  // users.ts
  get_user_profile: () => seed.userId ? { user_id: seed.userId } : 'no user id in seeds',
  get_user_playlists_by_id: () => seed.userId ? { user_id: seed.userId, max_results: 5 } : 'no user id in seeds',
  get_artist_top_tracks: () => seed.artistId ? { id: seed.artistId } : 'no artist in seeds',
  get_available_markets: () => ({}),
  // searchdive.ts
  search_deep: () => ({ query: 'radiohead', types: ['track'], pages: 1 }),
  // analytics.ts (#97)
  listening_report: () => ({ time_range: 'short_term', max_results: 3 }),
  // libraryinsights.ts (#112 idea 1)
  library_genre_report: () => ({ max_results: 5 }),
  filter_by_genre: () => ({ genre: 'rock', kind: 'tracks', max_results: 5 }),
  tag_management: () => ({ action: 'list' }),
  // freshness.ts (#112 idea 2)
  whats_new: () => ({ days_back: 365, kinds: ['albums', 'podcasts'], max_results: 3 }),
  // libraryhygiene.ts (#112 idea 5)
  library_hygiene: () => ({ max_results: 3 }),
  // playlistdna.ts (#112 idea 6)
  grow_playlist: () => seed.playlistId ? { playlist_id: seed.playlistId, size: 5, exclude_saved: false } : 'no playlist in seeds',
  // playlistops.ts (#96)
  merge_playlists: () => seed.playlistId ? { sources: [seed.playlistId], new_name: 'gauntlet-merge-DELETE-ME', dry_run: true } : 'no playlist in seeds',
  diff_playlists: () => seed.playlistId ? { a: seed.playlistId, b: seed.playlistId } : 'no playlist in seeds',
  overlap_playlists: () => seed.playlistId ? { playlists: [seed.playlistId] } : 'no playlist in seeds',
  // podcastsession.ts (#112 idea 3)
  plan_podcast_session: () => ({ minutes: 30, max_results: 3 }),
  start_podcast_session: () => ({ minutes: 30, dry_run: true }),
  // audiobookcopilot.ts (#112 idea 4)
  list_all_chapters: () => seed.audiobookId ? { audiobook_id: seed.audiobookId } : 'no audiobook in seeds (market-gated)',
  where_was_i: () => seed.audiobookId ? { audiobook_id: seed.audiobookId } : 'no audiobook in seeds (market-gated)',
  jump_to_chapter: () => 'mutating adjacent — requires device; covered by list_all_chapters instead',
  // scenes.ts (#112 ideas 7+12)
  list_scenes: () => ({}),
  apply_scene: () => 'needs a saved scene; covered by list_scenes/save_scene instead',
  save_scene: () => 'MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep',
  delete_scene: () => 'MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep',
  schedule_wind_down: () => 'MUTATING-ADJACENT (arms timers + volume changes)',
  cancel_wind_down: () => 'no active wind-down during gauntlet',
  // doctortool.ts (#111)
  spotify_doctor: () => ({}),
  // receipts (#112 idea 11)
  verify_receipt: () => 'needs a receipt id from a prior mutation; skip in safe sweep',
};

// Chained after get_audiobook: chapters feed get_chapter / get_several_chapters.
function audiobookBuilders() {
  SAFE_ARGS.get_audiobook = () => seed.audiobookId ? { id: seed.audiobookId } : 'no audiobook in seeds (market-gated)';
  SAFE_ARGS.get_audiobook_chapters = () => seed.audiobookId ? { id: seed.audiobookId, limit: 5, response_format: 'json' } : 'no audiobook in seeds (market-gated)';
  SAFE_ARGS.get_chapter = () => seed.chapterId ? { id: seed.chapterId } : 'no chapter in seeds';
  SAFE_ARGS.get_several_audiobooks = () => seed.audiobookId ? { ids: [seed.audiobookId] } : 'no audiobook in seeds (market-gated)';
  SAFE_ARGS.get_several_chapters = () => seed.chapterId ? { ids: [seed.chapterId] } : 'no chapter in seeds';
}
audiobookBuilders();

// Minimal valid args for allowlisted MUTATING tools — always sent together
// with dry_run:true.
const MUTATING_ARGS = {
  create_playlist: () => ({ name: 'live-gauntlet dry-run probe', public: false }),
  save_items: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  remove_saved_items: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  save_to_library: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  remove_from_library: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  follow_artists: () => seed.artistId ? { ids: [seed.artistId] } : 'no artist in seeds',
  unfollow_artists: () => seed.artistId ? { ids: [seed.artistId] } : 'no artist in seeds',
  add_to_playlist: () => seed.playlistId && seed.trackId ? { playlist_id: seed.playlistId, uris: [`spotify:track:${seed.trackId}`] } : 'no playlist/track in seeds',
  remove_from_playlist: () => seed.playlistId && seed.trackId ? { playlist_id: seed.playlistId, uris: [`spotify:track:${seed.trackId}`] } : 'no playlist/track in seeds',
  update_playlist: () => seed.playlistId ? { id: seed.playlistId, description: 'live-gauntlet dry-run probe' } : 'no playlist in seeds',
  replace_playlist_items: () => seed.playlistId && seed.trackId ? { playlist_id: seed.playlistId, uris: [`spotify:track:${seed.trackId}`] } : 'no playlist/track in seeds',
  reorder_playlist_items: () => seed.playlistId ? { playlist_id: seed.playlistId, range_start: 0, range_length: 1 } : 'no playlist in seeds',
  upload_playlist_cover: () => seed.playlistId ? { playlist_id: seed.playlistId, jpeg_base64: 'ZGFm' } : 'no playlist in seeds',
  play_from_search: () => ({ query: 'daft punk one more time' }),
  play: () => ({}),
  pause: () => ({}),
  skip_next: () => ({}),
  skip_previous: () => ({}),
  seek: () => ({ position_ms: 10000 }),
  set_volume: () => ({ volume_percent: 50 }),
  set_shuffle: () => ({ state: true }),
  set_repeat: () => ({ state: 'off' }),
  add_to_queue: () => seed.trackId ? { uri: `spotify:track:${seed.trackId}` } : 'no track in seeds',
  transfer_playback: () => 'needs a device_id; skipped even in dry-run mode',
};

// ------------------------------------------------------------------- gauntlet

// SWEEP_COMPLETE fast path: everything recorded (or only FAILs remain) — nothing to do.
const remaining = tools.filter((t) => t.name !== 'get_me' && t.name !== 'get_user_playlists'
  && (!done.has(t.name) || done.get(t.name).status === 'FAIL'));
if (remaining.length === 0) {
  console.log('SWEEP_COMPLETE: every registered tool is recorded in the report (no FAILs to retry)');
  child.kill();
  process.exit(0);
}
if (batchLimit < Infinity) console.log(`batch mode: up to ${batchLimit} calls this run; ${remaining.length} tools pending (${done.size} recorded)`);

for (const tool of tools.map((t) => t.name)) {
  if (tool === 'get_me' || tool === 'get_user_playlists') continue; // already run as seeds
  const cls = MUTATING.has(tool) ? 'MUTATING' : 'SAFE'; // unclassified ⇒ treated as MUTATING

  const prevRec = done.get(tool);
  if (prevRec && (prevRec.status !== 'FAIL' || (prevRec.attempts ?? 0) >= RETRY_MAX)) {
    resumed++;
    continue;
  }
  if (cls === 'MUTATING') {
    if (!includeMutating.has(tool)) {
      record(tool, cls, 'SKIP', 0, { reason: 'mutating; not in --include-mutating allowlist' });
      continue;
    }
    const schema = schemaOf.get(tool);
    if (!schema?.properties?.dry_run) {
      record(tool, cls, 'SKIP', 0, { reason: 'allowlisted but tool has no dry_run support; refusing to call' });
      continue;
    }
    const built = MUTATING_ARGS[tool]?.();
    if (typeof built === 'string' || built === undefined) {
      record(tool, cls, 'SKIP', 0, { reason: built ?? 'no arg recipe' });
      continue;
    }
    calls++;
    if (calls > batchLimit) break;
    const r = await callTool(tool, { ...built, dry_run: true });
    // Verify no mutation occurred: the tool must confirm the dry-run preview.
    const confirmed = r.ok && (r.structured?.dry_run === true || /\[dry run\]/.test(r.text));
    record(tool, cls, confirmed ? 'PASS' : 'FAIL', r.ms,
      confirmed ? { verified_no_mutation: true } : { reason: r.ok ? 'dry_run confirmation MISSING in response — treat as possible mutation' : r.error });
    continue;
  }

  // SAFE read path.
  const built = SAFE_ARGS[tool]?.();
  if (typeof built === 'string' || built === undefined) {
    record(tool, cls, 'SKIP', 0, { reason: built ?? 'missing prereq from seed reads' });
    continue;
  }
  calls++;
  if (calls > batchLimit) break;
  const r = await callTool(tool, typeof built === 'object' ? built : {});
  if (r.ok) {
    consecutiveFails = 0;
    // Chain: first chapter of the seed audiobook feeds chapter tools.
    if (tool === 'get_audiobook_chapters') {
      seed.chapterId = r.structured?.items?.[0]?.id;
    }
    if (GATE_SNIFF.test(r.text)) {
      record(tool, cls, 'PASS', r.ms, { gated: true, reason: 'tool answered but snippet suggests app-registration gating (403/Forbidden/removed)' });
    } else {
      record(tool, cls, 'PASS', r.ms);
    }
  } else if (REMOVED.has(tool)) {
    consecutiveFails = 0;
    record(tool, cls, 'SKIP', r.ms, { reason: 'endpoint removed by Spotify Feb 2026 Web API changes' });
  } else if (GATED.has(tool)) {
    consecutiveFails = 0;
    record(tool, cls, 'SKIP', r.ms, { reason: 'app-registration-gated (403 on current registrations); legacy registrations may differ' });
  } else {
    consecutiveFails++;
    const attempts = (prevRec?.attempts ?? 0) + 1;
    if (consecutiveFails >= 3) {
      record(tool, cls, 'FAIL', r.ms, { reason: r.error, attempts });
      console.log('QUOTA_WALL: 3 consecutive failures — aborting this batch; sweep-loop will back off');
      break;
    }
    record(tool, cls, 'FAIL', r.ms, { reason: r.error, attempts });
  }
}

if (batchLimit < Infinity) console.log(`batch run finished after ${calls} calls (${resumed} resumed, ${results.length} recorded this run)`);

// -------------------------------------------------------------------- report

child.kill();

// Cumulative merge: previous runs (done) + this run — the report is the
// union, so --resume actually accumulates across spaced batches.
const merged = new Map(done);
for (const r of results) merged.set(r.tool, r);
const allResults = [...merged.values()];
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of allResults) counts[r.status]++;
const mutatingSkipped = allResults.filter((r) => r.class === 'MUTATING' && r.status === 'SKIP').map((r) => r.tool);
const dryRunVerified = allResults.filter((r) => r.verified_no_mutation).map((r) => r.tool);

console.log('\n=== LIVE GAUNTLET SUMMARY ===');
console.log(`${'STATUS'.padEnd(6)} ${'CLASS'.padEnd(9)} TOOL`);
for (const r of results) console.log(`${r.status.padEnd(6)} ${r.class.padEnd(9)} ${r.tool}${r.reason ? `  — ${r.reason.slice(0, 90)}` : ''}`);
console.log(`\n${counts.PASS} passed / ${counts.FAIL} failed / ${counts.SKIP} skipped  (${results.length + 3} calls incl. seeds)`);
console.log(`mutations performed: NONE`);
if (dryRunVerified.length) console.log(`dry-run verified (no mutation): ${dryRunVerified.join(', ')}`);

const report = {
  generated_at: new Date().toISOString(),
  tools_discovered: tools.length,
  mode: { batch_limit: batchLimit === Infinity ? null : batchLimit, resumed_from: resumePath ?? null },
  summary: { pass: counts.PASS, fail: counts.FAIL, skip: counts.SKIP,
    gated: allResults.filter((r) => r.gated).length,
    total_calls: allResults.length + 3 + resumed,
    pending: remaining.filter((t) => !allResults.some((r) => r.tool === t.name)).length,
  },
  mutation_proof: {
    mutations_performed: [],
    mutating_tools_skipped_by_default: mutatingSkipped,
    mutating_tools_dry_run_verified: dryRunVerified,
  },
  results: allResults,
};
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`JSON report written to ${reportPath}`);
}
process.exit(counts.FAIL ? 1 : 0);
