#!/usr/bin/env node
// Tool-level gate check: spawn the real server, discover tools, and call the
// candidates that sit on the app-registration-gated surface. Read-only args.
//
// #1397: this used to spawn with no `env` at all, so the server inherited the
// developer's real $HOME and its local stores. The spawn is now unconditional and
// hermetic; see scripts/hermetic-home.mjs.
// #644: the spawn, the JSONL RPC loop, the handshake and the timeout policy
// moved to scripts/lib/mcp-client.mjs, which also runs the preconditions
// before the spawn.
//
// #645: this script now GATES. It used to end in an unconditional
// `process.exit(0)`, so a run in which every candidate was missing, every call
// threw, or the server never answered at all still exited 0 — green meant
// "ran", not "passed", which is why it was safe to leave unwired. Three
// changes, each with the defect it closes:
//
//   1. the exit code is now `summarizeRun(rows).exitCode`;
//   2. a candidate the registry does not publish is a counted FAILURE, not a
//      printed warning, and so is a call that does not come back as a clean
//      pass — including the GATED answers that used to be scored as passes
//      because a resolved `isError` result is not a rejected promise;
//   3. the candidate list is DERIVED from `GATED_FAMILIES` in src/gating.ts
//      rather than hand-kept (see deriveGatedToolNames for what had drifted).
//
// The verdicts live in scripts/lib/gate-decision.mjs so they can be exercised
// against fixtures; this file owns the RPC and the printing.
import { connect } from './lib/mcp-client.mjs';
import { STATUS, classifyToolResult, deriveGatedToolNames, summarizeRun } from './lib/gate-decision.mjs';
import { loadGatedFamilies } from './lib/gated-families.mjs';

/**
 * The candidate set, and WHY the toolset is forced.
 *
 * #645: two of the gated tools this script probes — `get_available_markets`
 * and `get_artist_top_tracks`, both in `catalog` — are NOT in the default
 * toolset (`core`, `resources`, `prompts`; #889). The sandbox strips every
 * `SPOTIFY_MCP_*` the parent carries, so on a default run they are absent from
 * `tools/list` and the script would report a FAILURE for a tool that is
 * registered and working. Asking for the full surface is what makes "not
 * registered" mean "not registered" rather than "not in this profile", and it
 * is the only way the not-registered check can be the drift guard it claims to
 * be.
 */
const TOOLSETS = process.env.SPOTIFY_MCP_TOOLSETS ?? 'all';

const client = await connect({
  label: 'tool-gate-check',
  name: 'tool-gate-check',
  cwd: new URL('..', import.meta.url).pathname,
  env: { SPOTIFY_MCP_TOOLSETS: TOOLSETS },
});
const { rpc } = client;

const { tools } = await rpc('tools/list', {});
const known = new Set(tools.map((t) => t.name));
console.log(`tools/list (SPOTIFY_MCP_TOOLSETS=${TOOLSETS}): ${tools.length}`);

// Seed ids. A failed seed is NOT fatal and is NOT a pass: the candidate is
// then probed with whatever the fallback id is, and a 404 on that id is
// reported as the FAIL it is. The old script swallowed the seed the same way,
// which meant a broken `search` produced a green run against a hard-coded
// 1998 Daft Punk id.
//
// One search per KIND, because the `get_several_*` family validates the SHAPE
// of each id before any request goes out: a track id handed to
// `get_several_albums` is rejected by the schema as `expected a value at least
// 1`, which is a broken harness rather than a gated endpoint. Seeding one
// search and reusing its id across kinds was the first version of this file and
// it reported seven schema rejections as seven functional failures.
const seed = async (name, args) => {
  let status = STATUS.PASS;
  let value = {};
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    const classified = classifyToolResult({ result: r, name });
    // The seeds are the run's INPUTS, not its coverage. An input that came
    // back auth-failed is not a passed seed, and treating its empty body as a
    // successful read is how a broken `search` produced a green run against a
    // hard-coded 1998 Daft Punk id.
    status = classified.status;
    value = r?.structuredContent ?? {};
  } catch (e) {
    status = STATUS.FAIL;
  }
  return { value, status };
};

// `get_me` is the ONLY seed that is not a search, and deliberately: `/me` is
// not on the gated surface, so a token that is valid but registration-gated
// still yields a user id. Every other id comes from `search`, whose sections
// are NOT gated.
//
// The earlier version seeded the playlist id from `get_user_playlists`, which is
// itself a gated tool (`/me/playlists` was removed in February 2026). A harness
// must not take its input from the thing it is testing: on a current app
// registration that seed 403s, the id is empty, and `get_playlist_followers`
// is then reported as a functional failure for a reason that has nothing to do
// with it. `playlist` is a searchable kind, so search seeds it without
// touching a removed endpoint.
const meSeed = await seed('get_me', { response_format: 'json' });

// `search` in json mode returns Spotify's RAW object, so the section keys are
// the API's plurals, not the kind names this script asks for. Reading
// `value[kind]` returns undefined for every kind, which is what turned a
// working server into twelve "no seed id" failures.
const section = (kind) => `${kind}s`;
const kind = async (type) => {
  const r = await seed('search', { query: 'daft punk', types: [type], limit: 1, response_format: 'json' });
  const items = r.value?.[section(type)]?.items;
  return { id: Array.isArray(items) ? items[0]?.id : undefined, status: r.status };
};

const tracks = await kind('track');
const artists = await kind('artist');
const albums = await kind('album');
const playlists = await kind('playlist');
const shows = await kind('show');
const episodes = await kind('episode');
const audiobooks = await kind('audiobook');

const trackId = tracks.id;
const artistId = artists.id;
const albumId = albums.id;
const showId = shows.id;
const episodeId = episodes.id;
const audiobookId = audiobooks.id;
const playlistId = playlists.id;
// `get_me` renders through renderSingle, whose json branch is the raw profile
// object — so `id` sits at the top level, not under a section or `items`.
const uid = meSeed.value?.id;

// #645: one bad input must not become nine "functional failures". Every
// candidate above is derived from a seed, so when the SEED cannot be read the
// whole run is untestable — and saying "11 failed" would send an operator after
// eleven server regressions when the truth is that nothing was called. An
// unreadable seed is reported as itself, once, and gates the run.
const seedStatuses = [meSeed.status, tracks.status, artists.status, albums.status, playlists.status, shows.status, episodes.status, audiobooks.status];
if (seedStatuses.includes(STATUS.AUTH)) {
  const summary = summarizeRun([{ name: 'seeds', status: STATUS.AUTH, detail: 'a seed read could not authenticate' }]);
  console.log('\n=== TOOL GATE ===');
  console.log(`${STATUS.AUTH.padEnd(5)} seeds                            could not authenticate`);
  console.log(`\nno candidate was probed: the run's ids come from seed reads that need a valid token.`);
  console.log(summary.authNote);
  client.close();
  process.exit(summary.exitCode);
}

// The gated-family tools, with the minimal read-only arguments each needs.
// The NAMES are derived (below); only the argument recipes are hand-written,
// because they are properties of each tool's schema rather than of the gated
// surface. A tool with no recipe is reported as unprobeable rather than
// silently skipped -- see UNPROBEABLE.
const ARG_RECIPES = {
  get_artist_top_tracks: () => ({ id: artistId }),
  get_user_profile: () => ({ user_id: uid }),
  get_user_playlists_by_id: () => ({ user_id: uid }),
  get_playlist_followers: () => ({ playlist_id: playlistId }),
  get_category: () => ({ category_id: 'party' }),
  get_several_tracks: () => ({ ids: [trackId] }),
  get_several_artists: () => ({ ids: [artistId] }),
  get_several_albums: () => ({ ids: [albumId] }),
  get_several_shows: () => ({ ids: [showId] }),
  get_several_episodes: () => ({ ids: [episodeId] }),
  get_several_audiobooks: () => ({ ids: [audiobookId] }),
  get_available_markets: () => ({}),
  market_validate: () => ({}),
};

/**
 * Gated tools this script cannot call, each with the reason.
 *
 * Listed rather than omitted: a gated tool that exists and is never probed is a
 * coverage hole, and a hole that is invisible in the output is how the original
 * 8-name list went stale without anyone noticing. These are all WRITES or
 * composite tools that reach a gated read only as one step of a larger
 * operation, and this script's safety contract is read-only arguments, so
 * probing them would mean writing to a real account to test a read.
 */
const UNPROBEABLE = new Map([
  // `chapters` is NOT one of SPOTIFY_SEARCHABLE_KINDS (src/refs.ts) and a
  // chapter id is a composite audiobook/chapter segment rather than a bare id,
  // so there is no seedable chapter to hand the tool. It belongs here and NOT in
  // a FAIL row: a tool that can never be probed would otherwise make exit 0
  // unreachable, and a permanently-red gate is a gate nobody runs. The hole
  // stays visible in the [SKIP] line above.
  ['get_several_chapters', 'no seedable chapter id: chapters is not a searchable kind (SPOTIFY_SEARCHABLE_KINDS, src/refs.ts)'],
  ['queue_playlist', 'reaches the gated read only inside a write to the player queue'],
  ['batch_add_to_playlist', 'reaches the gated read only inside a playlist write'],
  ['copy_playlist', 'reaches the gated read only inside a playlist write'],
  ['move_items_between_playlists', 'reaches the gated read only inside a playlist write'],
  ['artist_collab_network', 'not annotated read-only; its dry_run is not audited by the gauntlet'],
  ['artist_completeness_score', 'not annotated read-only'],
  ['browse_category_deepdive', 'not annotated read-only'],
  ['category_resolver', 'not annotated read-only'],
  ['catalog_batch_lookup', 'not annotated read-only'],
]);

const families = await loadGatedFamilies();
const candidates = deriveGatedToolNames(families);

const rows = [];

// 1. Registration. A gated tool the registry does not publish is a FAILURE: it
//    is either deleted (and the families table is stale) or it moved behind a
//    gate the surface census does not know about. Either way the operator needs
//    to hear about it, and a printed warning that changes no exit code is how
//    the drift went unnoticed.
for (const name of candidates) {
  if (known.has(name)) continue;
  if (UNPROBEABLE.has(name)) continue;
  console.log(`!! tool not registered: ${name}`);
  rows.push({ name, status: STATUS.FAIL, detail: 'not present in tools/list' });
}

for (const name of candidates) {
  if (UNPROBEABLE.has(name)) {
    console.log(`[SKIP] ${name.padEnd(30)} not probeable read-only: ${UNPROBEABLE.get(name)}`);
    continue;
  }
  if (!known.has(name)) continue;
  const recipe = ARG_RECIPES[name];
  if (!recipe) {
    console.log(`[SKIP] ${name.padEnd(30)} no read-only argument recipe`);
    rows.push({ name, status: STATUS.FAIL, detail: 'gated tool has no read-only argument recipe' });
    continue;
  }

  // A seed that did not resolve must not be sent as `undefined`. The server
  // would reject it on the schema, and that rejection is a HARNESS fault being
  // reported as a functional failure — the #803 shape: a read that was never
  // attempted, reported as a read that failed.
  const args = recipe();
  const missingArg = Object.entries(args).find(([, v]) => v === undefined || (Array.isArray(v) && v.some((x) => x === undefined)));
  if (missingArg) {
    console.log(`[SKIP] ${name.padEnd(30)} no seed id for ${missingArg[0]} (search returned nothing)`);
    rows.push({ name, status: STATUS.FAIL, detail: `no seed id for ${missingArg[0]}: the probe was never attempted` });
    continue;
  }

  const t0 = Date.now();
  let row;
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    row = classifyToolResult({ result: r, name });
  } catch (e) {
    row = classifyToolResult({ error: e, name });
  }
  const ms = String(Date.now() - t0).padStart(5);
  const flag = row.status === STATUS.PASS ? 'PASS' : row.status;
  console.log(`[${flag}] ${name.padEnd(30)} ${ms}ms  ${row.detail.slice(0, 90)}`);
  rows.push(row);
  await new Promise((r) => setTimeout(r, 700));
}

const summary = summarizeRun(rows);

console.log('\n=== TOOL GATE ===');
for (const r of rows) console.log(`${r.status.padEnd(5)} ${r.name.padEnd(30)} ${r.detail.slice(0, 100)}`);
console.log(
  `\n${summary.ratio} passed (functional); ${summary.tested}/${summary.total} tested; ${summary.gated} gated; ${summary.auth} auth; ${summary.failed} failed`,
);
if (summary.authNote) console.log(summary.authNote);
console.log(
  `NOTE: a GATED answer is a TESTED row — the DESIGNED degradation for a current app registration, not a regression, and not a reason to fail the run. It is excluded from the pass ratio because its contract is a disclosure, not data. See src/gating.ts.`,
);

client.close();
process.exit(summary.exitCode);
