#!/usr/bin/env node
// Live gauntlet: exercises every registered MCP tool against the real Spotify
// API and computes — from observed state, not from a constant — whether
// anything was mutated.
//
// Prereqs: npm run build && npm run auth && .env present (tokens in
// ~/.spotify-mcp/tokens.json — the harness COPIES that file into a throwaway
// home; the live one is never opened for writing, and never read again after the
// copy).
//
// Usage:
//   node scripts/live-gauntlet.mjs [report.json]
//   node scripts/live-gauntlet.mjs --include-mutating=create_playlist,save_to_library [report.json]
//   node scripts/live-gauntlet.mjs --batch=40 --resume=memory/live-sweep-report.json --report=memory/live-sweep-report.json
//
// Batch/resume mode (quota-paced sweeps of the full surface):
//   --batch=N      stop after N sweep tool calls this run. Seed reads and the
//                  account-state check are counted separately and are not
//                  capped: they are not coverage, they are the run's inputs.
//   --resume=FILE  skip tools already recorded in FILE (FAILs are retried)
//   --report=FILE  cumulative report location (used by --resume)
// A run with nothing left to do prints SWEEP_COMPLETE and exits 0.
//
// Safety model (#643 — the previous version's comment described the opposite of
// what its code did, and its "proof" was a constant):
//   - SAFE (reads) vs MUTATING is DERIVED from the registry: a tool is MUTATING
//     unless `tools/list` advertises `readOnlyHint: true` for it AND its schema
//     declares no `dry_run`. A tool name this file has never seen is MUTATING.
//     The only exception is REVIEWED_READS in live-gauntlet-core.mjs, which is
//     per-entry audited and re-checked against the registry on every run.
//   - Every run prints a classification audit, and the run FAILS before it calls
//     anything if the audit is inconsistent (a write classified SAFE, a
//     dry_run-declaring tool classified SAFE without a REVIEWED_READS entry, or a
//     REVIEWED_READS entry the registry does not call read-only).
//     Arg recipes naming unregistered tools are reported loudly but do not
//     gate: nothing is called because of an orphan recipe.
//   - MUTATING tools are skipped unless named in --include-mutating=a,b AND
//     their inputSchema declares `dry_run`. The call always passes dry_run:true
//     and PASSES only when the response confirms it STRUCTURALLY
//     (`structuredContent.dry_run === true`). A prose "[dry run]" is recorded
//     as UNVERIFIED, never as a pass: the tool's own sentence is not evidence.
//   - The server runs in a THROWAWAY HOME (#1397). `spawnHarnessServer` builds a
//     fresh `mkdtemp` root, points `HOME`/`USERPROFILE` at it, deletes every
//     inherited `SPOTIFY_MCP_*` override, and re-pins all eighteen local stores
//     inside it, so the `join(homedir(), '.spotify-mcp', …)` defaults land in
//     the sandbox rather than in the developer's real store. Only the OAuth token
//     file is copied in, because a sweep has to authenticate to be worth running
//     and a token file is written in place on refresh — so the harness has never
//     had a path to the real one.
//   - `mutations detected` is the size of a diff between an account-state
//     fingerprint taken before and after the run, over the user's saved-track
//     count, saved-album count, playlist count, and the hash of the playlist id
//     set. It covers library membership and the playlist set; it does NOT cover
//     reordering or per-item edits inside a playlist, and the report says so
//     rather than implying a whole-account guarantee.
//   - The proof is PASS / INCOMPLETE / UNVERIFIED / MUTATIONS_DETECTED, and only
//     PASS is a claim. UNVERIFIED and MUTATIONS_DETECTED exit non-zero. A
//     batched sweep is INCOMPLETE by construction and makes no claim until the
//     run that records the last pending tool.
//
// Decision logic lives in ./live-gauntlet-core.mjs so it can be exercised
// against fixtures; this file owns the RPC and nothing else.
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
// #644: the spawn, the JSONL RPC loop, the handshake and the timeout policy all
// live in scripts/lib/mcp-client.mjs now, along with the preconditions that run
// BEFORE the spawn. This file previously held its own copy of the transport, its
// own 120s timeout and its own hard-coded protocol revision.
import { connect, looksGated } from './lib/mcp-client.mjs';
import {
  ACCOUNT_PROBES,
  MUTATING,
  SAFE,
  auditClassification,
  auditRecipeTables,
  computeMutationProof,
  proofBlocksExit,
  renderAuditLines,
  renderProofLines,
  schemaDeclaresDryRun,
  snapshotFromProbeResponses,
} from './live-gauntlet-core.mjs';

const ROOT = join(dirname(new URL(import.meta.url).pathname), '..');

// Endpoints Spotify removed in its Feb 2026 Web API changes: registered but
// expected to fail on newer app registrations. A failure here is reported as
// SKIP, not FAIL.
//
// #638: this set used to carry a second, awkward group — `follow_artists`,
// `unfollow_artists`, `get_categories` and `get_category_playlists` were
// REGISTERED, could never work, and were parked here until the tools
// themselves were deleted. They are deleted now. This file reads a live
// `tools/list`, so a name left in a set that no longer registers is dead
// weight that reads as coverage — which is why every hand-kept set in this
// file is now audited against the registry on each run instead of trusted.
//
// `get_artist_top_tracks` / `get_available_markets` / `get_user_profile` /
// `get_user_playlists_by_id` stay: those endpoints are gone but the tools
// degrade truthfully (a named 403 explaining the removal, or a replacement
// read), so a live FAIL here is a real regression. A tool that cannot answer
// at all does not belong in this file.
const REMOVED = new Set([
  'get_artist_top_tracks', 'get_available_markets', 'get_user_profile', 'get_user_playlists_by_id',
]);

// Endpoints that 403 Forbidden on current app registrations (2026-08-27 edge
// probe): documented /me/*/contains family, browse categories, and friends.
// Legacy registrations may still serve them; failure here is SKIP, not FAIL.
// #638: `get_categories`, `get_category_playlists` and `check_saved_items` were
// deleted with the endpoints they wrapped. `check_in_library` and
// `check_following_artists` stay — they read `/me/library/contains`, which is
// NOT gated, and a FAIL against them is a genuine regression.
const GATED = new Set([
  'get_new_releases',
  'check_in_library', 'check_following_artists',
  'check_following_playlist', 'check_following_artists_and_users',
]);

// --------------------------------------------------------------- JSONL RPC layer

// #1397: the `env` is built by spawnHarnessServer and is NOT optional, not
// configurable, and not a flag. A sweep must not be able to reach the developer's
// real ~/.spotify-mcp by any code path, including one added later.
//
// #644: all of it is now in scripts/lib/mcp-client.mjs. `looksGated` replaces
// the GATE_SNIFF regex that was duplicated byte-for-byte here and in
// sweep-finalize.mjs.
const client = await connect({ label: 'live-gauntlet', name: 'live-gauntlet', cwd: ROOT });
const { rpc } = client;
const textOf = client.textOf;

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
let calls = 0;           // sweep tool calls performed this run (seeds and state check excluded)
let seedCalls = 0;       // seed reads performed this run
let stateProbeCalls = 0; // account-state fingerprint reads performed this run
let resumed = 0;         // tools skipped due to prior records
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
// sweeps hours apart, or verify subsets per run — coverage across the day's
// runs is what the cumulative report records, and `mutation_proof.status`
// says INCOMPLETE until the last pending tool lands.

// ---------------------------------------------------------------------- seeds

// Minimal reads whose results feed every other SAFE call's arguments.
const seed = {}; // { userId, trackId, albumId, artistId, showId, episodeId, audiobookId, playlistId }
const results = [];
const invocations = []; // every mutating call actually issued, for the proof

function record(name, cls, status, ms, extra = {}) {
  results.push({ tool: name, class: cls, status, latency_ms: ms, ...extra });
  const flag = status === 'PASS' ? '+' : status === 'SKIP' ? '-' : 'x';
  console.log(`[${flag}] ${status.padEnd(5)} ${(cls + ' ' + name).padEnd(40)} ${ms}ms ${extra.reason ?? ''}`);
}

// ------------------------------------------------------- SAFE arg derivation

// Each builder returns minimal args from the seed reads, or a skip reason.
//
// A key here names a SAFE tool, and that is now enforced rather than assumed:
// `auditRecipeTables` fails the run if this table names a tool that no longer
// registers, and reports (without failing) if it names a tool the registry
// calls a write — because such a recipe can never run, and leaving it in place
// is how the read path came to cover mutating tools. `library_genre_report`
// and `filter_by_genre` were among them: genuine read-only reports whose names
// carry no read verb, so the registry advertised them as writes and #1336's
// fail-closed classification moved them to MUTATING_ARGS. #1347 fixed that at
// the source — OVERRIDES rows in src/tools/annotations.ts — and their recipes
// are back here. `library_hygiene` is the same shape and is still gated; it is
// named in the per-run `uncalled registry writes` line rather than left to be
// inferred from its absence.
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
  list_show_episodes: () => seed.showId ? { show_id: seed.showId, max_results: 5 } : 'no show in seeds',
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
  // playlistdna.ts (#112 idea 6)
  // Canonical playlist power tools. These keys must name registered tools:
  // a recipe under a name no tool answers to is silently recorded as a skip,
  // and the recipe audit now fails the run on one.
  diff_playlists: () => seed.playlistId ? { playlist_a: seed.playlistId, playlist_b: seed.playlistId } : 'no playlist in seeds',
  // podcastsession.ts (#112 idea 3)
  plan_podcast_session: () => ({ minutes: 30, max_results: 3 }),
  // audiobookcopilot.ts (#112 idea 4)
  list_all_chapters: () => seed.audiobookId ? { audiobook_id: seed.audiobookId } : 'no audiobook in seeds (market-gated)',
  where_was_i: () => seed.audiobookId ? { audiobook_id: seed.audiobookId } : 'no audiobook in seeds (market-gated)',
  // scenes.ts (#112 ideas 7+12)
  list_scenes: () => ({}),
  // doctortool.ts (#111)
  spotify_doctor: () => ({}),
  // receipts (#112 idea 11)
  verify_receipt: () => 'needs a receipt id from a prior mutation; skip in safe sweep',
  // #1347: these two are SAFE on the registry now (OVERRIDES readOnlyHint in
  // src/tools/annotations.ts), and a classification change alone does not bring
  // them back — the SAFE path looks the recipe up HERE, so a SAFE tool with no
  // row is still recorded as a skip, just with a different reason. The recipes
  // moved out of MUTATING_ARGS, where they had been unreachable since #1336
  // classified these two names MUTATING.
  library_genre_report: () => ({ max_results: 5 }),
  filter_by_genre: () => ({ genre: 'rock', kind: 'tracks', max_results: 5 }),
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
// with dry_run:true, which the driver adds and no recipe sets.
//
// Entries that read like reads moved here from the read path in #643: the
// registry classifies them as writes, so the only way this harness may call
// them is under the same dry-run gate as every other write. A recipe that
// returns a string is a recorded skip carrying that reason.
//
// COVERAGE NOTE, and the honest cost of failing closed. Three of the recipes
// that moved here in #643 — `save_scene`, `delete_scene`, `cancel_wind_down` —
// declare no `dry_run`, so the gate can never call them: a MUTATING tool is
// only called when it is allowlisted AND its schema declares a commit path.
// They are not a coverage regression, and this is why that matters.
//
// #1336 moved them off the read path, but their recipes have returned a SKIP
// STRING since 1.30.1 — the SAFE path records a string recipe as a skip, not a
// call. The sweep was already skipping them before #1336 and skipped them
// after it. The coverage they appear to have lost was never coverage.
//
// The other two #1347 named — `library_genre_report`, `filter_by_genre` — were
// different, and are now genuinely called again: their recipes returned real
// arguments, so the sweep really did exercise them, and #1336 stopped it. They
// are fixed at the source, by OVERRIDES rows in src/tools/annotations.ts, the
// same table that already carries `playlist_staleness_report` and
// `backup_library`, plus the recipes above.
//
// The three remaining are left gated deliberately, not by oversight:
//   - `save_scene` / `delete_scene` write and delete a `scenes.json` sidecar.
//     They are ungated **on coverage grounds only**: the sweep has no real saved
//     scene to exercise them against, and calling them would seed a sandbox
//     scene and then delete the name it invented. The reason is no longer the
//     one it used to be. This comment previously said the harness "spawns the
//     server WITHOUT a HOME override", and since #1397 that has been false — the
//     spawn is unconditionally hermetic (see the safety model above), so a scene
//     write can no longer reach the developer's real `~/.spotify-mcp/scenes.json`.
//     The gate stays because the OVERRIDES that would make these two reachable
//     are a coverage decision to make deliberately, and a stale safety claim in a
//     comment is worse than no claim at all: it is the §6 failure where naming
//     is treated as documentation and the wire format disagrees.
//   - `cancel_wind_down` clears the in-process ramp, and its recipe has never
//     had a wind-down to clear; the harness arms none.
// Reclassifying any of them read-only to satisfy the gate would be a false
// annotation to every MCP host, not just to this script: all three write.
// `classifyTool` reports this set by name on every run — see the
// `uncalled registry writes` line in the classification audit — so the gap is
// visible rather than silent, which is the whole point of #643.
const MUTATING_ARGS = {
  whats_new: () => ({ kinds: ['albums'], since: '2026-01-01', max_results: 5, max_artists: 1 }),
  merge_playlists: () => seed.playlistId ? { sources: seed.playlistIds ?? [seed.playlistId], new_name: 'gauntlet-merge-DELETE-ME' } : 'no playlist in seeds',
  create_playlist: () => ({ name: 'live-gauntlet dry-run probe', public: false }),
  save_to_library: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
  remove_from_library: () => seed.trackId ? { uris: [`spotify:track:${seed.trackId}`] } : 'no track in seeds',
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
  // Reachable on the old read path with no dry-run guard (#643).
  tag_management: () => ({ action: 'list' }),
  grow_playlist: () => seed.playlistId ? { playlist_id: seed.playlistId, size: 5, exclude_saved: false } : 'no playlist in seeds',
  overlap_playlists: () => (seed.playlistIds?.length ?? 0) >= 2 ? { playlists: seed.playlistIds.slice(0, 2) } : 'fewer than 2 playlists in seeds',
  start_podcast_session: () => ({ minutes: 30 }),
  // #1347: library_genre_report and filter_by_genre used to sit here and are
  // now in SAFE_ARGS, where they are reachable again. Left in both tables they
  // would be a recipe naming a tool the registry calls a read, which
  // `auditRecipeTables` reports — and a dead row is how a tool looks covered
  // while nothing calls it.
  library_hygiene: () => ({ max_results: 3 }),
  jump_to_chapter: () => 'mutating adjacent — requires device; covered by list_all_chapters instead',
  apply_scene: () => 'needs a saved scene; covered by list_scenes/save_scene instead',
  save_scene: () => 'MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep',
  delete_scene: () => 'MUTATING-ADJACENT (writes sidecar); not exercised by the safe sweep',
  schedule_wind_down: () => 'MUTATING-ADJACENT (arms timers + volume changes)',
  cancel_wind_down: () => 'no active wind-down during gauntlet',
};

// ----------------------------------------------------------------- audit + gate

// The audit runs before ANY tool call. A run whose classification is internally
// inconsistent cannot make a safety claim, so it stops here rather than after
// spending the quota to produce a report nobody should read.
const audit = auditClassification(tools);
const classification = audit.verdicts;
const classFor = (name) => classification.get(name)?.class ?? MUTATING;
const recipeAudit = auditRecipeTables(tools, classification, { SAFE_ARGS, MUTATING_ARGS });

for (const line of renderAuditLines(audit)) console.log(line);
for (const warning of audit.warnings) console.log(`  WARNING: ${warning}`);
for (const orphan of recipeAudit.orphans) console.log(`  WARNING: arg recipe names an unregistered tool: ${orphan}`);
for (const entry of recipeAudit.unreachable) console.log(`  read-path arg recipe can never run: ${entry}`);
if (audit.unannotatedCount > 0) {
  console.log(`  WARNING: ${audit.unannotatedCount} registered tool(s) carry no annotations block; they are classified MUTATING`);
}
for (const name of includeMutating) {
  if (!classification.has(name)) console.log(`  --include-mutating names ${name}, which no registered tool answers to`);
  else if (classFor(name) !== MUTATING) console.log(`  --include-mutating names ${name}, which is classified ${classFor(name)}; it stays on the read path`);
}

// Only the classification invariants gate the run. An orphan recipe is a
// coverage-hygiene problem, not a safety one — nothing is called because of it —
// and gating on it would make a sweep against a trimmed surface (toolsets, an
// --include-mutating subset) impossible to run at all. It is reported loudly
// instead.
if (audit.errors.length > 0) {
  console.error('\nCLASSIFICATION_AUDIT_FAILED — refusing to run the sweep:');
  for (const error of audit.errors) console.error(`  - ${error}`);
  client.close();
  process.exit(1);
}

// ---------------------------------------------------------------------- seeds
{
  // Every seed read is counted. The audiobook `search` was never recorded, so
  // the banner and `summary.total_calls` each understated the run by one call
  // and did not agree with each other (#643).
  seedCalls++;
  let r = await callTool('get_me', { response_format: 'json' });
  if (r.ok) {
    const me = r.structured ?? {};
    seed.userId = me.id;
    seed.country = me.country;
    record('get_me', SAFE, 'PASS', r.ms);
  } else record('get_me', SAFE, 'FAIL', r.ms, { reason: r.error });

  seedCalls++;
  r = await callTool('search', { query: 'daft punk', types: ['track', 'show', 'episode'], limit: 3, response_format: 'json' });
  if (r.ok) {
    const t = r.structured?.tracks?.items?.[0];
    if (t) { seed.trackId = t.id; seed.albumId = t.album?.id; seed.artistId = t.artists?.[0]?.id; }
    seed.showId = r.structured?.shows?.items?.[0]?.id;
    seed.episodeId = r.structured?.episodes?.items?.[0]?.id;
    record('search', SAFE, 'PASS', r.ms);
  } else record('search', SAFE, 'FAIL', r.ms, { reason: r.error });

  // Audiobooks are market-gated; failure here just skips the audiobook tools.
  seedCalls++;
  r = await callTool('search', { query: 'project hail mary', types: ['audiobook'], limit: 3, response_format: 'json' });
  if (r.ok) seed.audiobookId = r.structured?.audiobooks?.items?.[0]?.id;

  seedCalls++;
  r = await callTool('get_user_playlists', { max_results: 10, response_format: 'json' });
  if (r.ok) {
    const rows = Array.isArray(r.structured) ? r.structured : r.structured?.items ?? [];
    seed.playlistIds = rows.map((p) => p?.id).filter(Boolean).slice(0, 3);
    seed.playlistId = seed.playlistIds[0];
    record('get_user_playlists', SAFE, 'PASS', r.ms);
  } else record('get_user_playlists', SAFE, 'FAIL', r.ms, { reason: r.error });
}

// ------------------------------------------------------------------- gauntlet

// SWEEP_COMPLETE fast path: everything recorded (or only FAILs remain) — nothing to do.
const remaining = tools.filter((t) => t.name !== 'get_me' && t.name !== 'get_user_playlists'
  && (!done.has(t.name) || done.get(t.name).class !== classFor(t.name) || done.get(t.name).status === 'FAIL'));
if (remaining.length === 0) {
  console.log('SWEEP_COMPLETE: every registered tool is recorded in the report (no FAILs to retry)');
  // Still state the proof, from the cumulative records. This path issues no
  // calls, so there is no state check and the run says exactly that rather
  // than printing a mutation count it did not measure.
  const completeProof = computeMutationProof({
    classification,
    records: [...done.values()],
    invocations: [],
    callsMade: 0,
  });
  for (const line of renderProofLines(completeProof)) console.log(line);
  client.close();
  process.exit(proofBlocksExit(completeProof) ? 1 : 0);
}
if (batchLimit < Infinity) console.log(`batch mode: up to ${batchLimit} calls this run; ${remaining.length} tools pending (${done.size} recorded)`);

/**
 * Read the account state. Counted separately from sweep calls: this is the
 * run's evidence, not its coverage, and folding it into `total_calls` is how
 * the old report's number stopped describing anything.
 */
async function takeFingerprint() {
  const responses = [];
  for (const probe of ACCOUNT_PROBES) {
    stateProbeCalls++;
    const r = await callTool(probe.tool, { ...probe.args });
    responses.push({ probe, ok: r.ok, structured: r.structured, error: r.error });
  }
  return snapshotFromProbeResponses(responses);
}

const fingerprintBefore = await takeFingerprint();

for (const tool of tools.map((t) => t.name)) {
  if (tool === 'get_me' || tool === 'get_user_playlists') continue; // already run as seeds
  const cls = classFor(tool);

  let prevRec = done.get(tool);
  if (prevRec && prevRec.class !== cls) {
    done.delete(tool);
    prevRec = undefined;
  }
  if (prevRec && (prevRec.status !== 'FAIL' || (prevRec.attempts ?? 0) >= RETRY_MAX)) {
    resumed++;
    continue;
  }
  if (cls === MUTATING) {
    if (!includeMutating.has(tool)) {
      record(tool, cls, 'SKIP', 0, { reason: 'mutating; not in --include-mutating allowlist' });
      continue;
    }
    if (!schemaDeclaresDryRun(schemaOf.get(tool))) {
      record(tool, cls, 'SKIP', 0, { reason: 'allowlisted but tool has no dry_run support; refusing to call' });
      continue;
    }
    const built = MUTATING_ARGS[tool]?.();
    if (typeof built === 'string' || built === undefined) {
      record(tool, cls, 'SKIP', 0, { reason: built ?? 'no arg recipe' });
      continue;
    }
    if (calls >= batchLimit) break;
    calls++;
    const r = await callTool(tool, { ...built, dry_run: true });
    invocations.push({ tool, dry_run: true, ok: r.ok, structured: r.structured, text: r.text, error: r.error });
    // Verify no mutation occurred STRUCTURALLY. A prose "[dry run]" is what the
    // previous version accepted, and a tool that merely says it previewed
    // something is not evidence that it did (#643).
    const confirmed = r.ok && r.structured?.dry_run === true;
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
  if (calls >= batchLimit) break;
  calls++;
  const r = await callTool(tool, typeof built === 'object' ? built : {});
  if (r.ok) {
    consecutiveFails = 0;
    // Chain: first chapter of the seed audiobook feeds chapter tools.
    if (tool === 'get_audiobook_chapters') {
      seed.chapterId = r.structured?.items?.[0]?.id;
    }
    if (looksGated(r.text)) {
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

const fingerprintAfter = await takeFingerprint();

if (batchLimit < Infinity) console.log(`batch run finished after ${calls} calls (${resumed} resumed, ${results.length} recorded this run)`);

// -------------------------------------------------------------------- report

client.close();

// Cumulative merge: previous runs (done) + this run — the report is the
// union, so --resume actually accumulates across spaced batches.
const merged = new Map(done);
for (const r of results) merged.set(r.tool, r);
const allResults = [...merged.values()];
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const r of allResults) counts[r.status]++;
const mutatingSkipped = allResults.filter((r) => r.class === MUTATING && r.status === 'SKIP').map((r) => r.tool);
const dryRunVerified = allResults.filter((r) => r.verified_no_mutation).map((r) => r.tool);

// The proof is the only thing in this file allowed to say nothing was mutated.
// It is computed from the observed state diff, the per-call structured
// confirmations, and whether every MUTATING tool is accounted for.
const proof = computeMutationProof({
  classification,
  records: allResults,
  invocations,
  callsMade: calls,
  before: fingerprintBefore,
  after: fingerprintAfter,
});

console.log('\n=== LIVE GAUNTLET SUMMARY ===');
console.log(`${'STATUS'.padEnd(6)} ${'CLASS'.padEnd(9)} TOOL`);
for (const r of results) console.log(`${r.status.padEnd(6)} ${r.class.padEnd(9)} ${r.tool}${r.reason ? `  — ${r.reason.slice(0, 90)}` : ''}`);
console.log(`\n${counts.PASS} passed / ${counts.FAIL} failed / ${counts.SKIP} skipped`);
console.log(`calls this run: ${calls} sweep + ${seedCalls} seed + ${stateProbeCalls} state-check = ${calls + seedCalls + stateProbeCalls} (${resumed} tools resumed from ${resumePath ?? 'no report'})`);
for (const line of renderProofLines(proof)) console.log(line);
if (dryRunVerified.length) console.log(`dry-run verified (no mutation): ${dryRunVerified.join(', ')}`);

const report = {
  generated_at: new Date().toISOString(),
  tools_discovered: tools.length,
  mode: { batch_limit: batchLimit === Infinity ? null : batchLimit, resumed_from: resumePath ?? null },
  summary: {
    pass: counts.PASS, fail: counts.FAIL, skip: counts.SKIP,
    gated: allResults.filter((r) => r.gated).length,
    // Every call this run actually issued, split by what it was for. The old
    // report added a literal 3 to the record count: wrong against the four
    // seed reads, and a different number from the banner's (#643).
    total_calls: calls + seedCalls + stateProbeCalls,
    calls_this_run: { sweep: calls, seeds: seedCalls, state_check: stateProbeCalls },
    tools_recorded: allResults.length,
    resumed,
    pending: remaining.filter((t) => !allResults.some((r) => r.tool === t.name)).length,
  },
  classification: {
    audit: `${audit.mutating} MUTATING / ${audit.safe} SAFE / ${audit.reviewedReadCount} REVIEWED_READS of ${audit.total} registered`,
    source: 'tools/list annotations (readOnlyHint) plus inputSchema dry_run; see scripts/live-gauntlet-core.mjs',
    mutating: audit.mutating,
    safe: audit.safe,
    dry_run_declared: audit.dryRunDeclared,
    reviewed_reads: audit.reviewedReads,
    // #1347: the tools this sweep structurally cannot call, measured from the
    // registry rather than declared by hand. A reader of this report can now
    // see which registered tools its coverage does not include.
    uncalled_registry_writes: audit.uncalledRegistryWrites,
    uncalled_registry_write_count: audit.uncalledRegistryWriteCount,
  },
  mutation_proof: {
    status: proof.status,
    state_check: proof.state_check,
    state_check_scope: 'saved-track count, saved-album count, playlist count, playlist id-set hash. Does NOT cover reordering or per-item edits inside a playlist, and does not cover state outside the account\'s own library and playlists.',
    mutations_detected: proof.mutations_detected,
    mutations_known: proof.mutations_known,
    mutations_performed: proof.mutations_performed,
    mutating_tools_skipped_by_default: mutatingSkipped,
    mutating_tools_dry_run_verified: dryRunVerified,
    unverified_invocations: proof.unverified,
    unaccounted_mutating_tools: proof.unaccounted,
    pending_mutating_tools: proof.pending,
    fingerprint: proof.fingerprint,
  },
  results: allResults,
};
if (reportPath) {
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`JSON report written to ${reportPath}`);
}
process.exit((counts.FAIL || proofBlocksExit(proof)) ? 1 : 0);
