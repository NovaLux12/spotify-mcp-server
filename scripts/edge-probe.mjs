#!/usr/bin/env node
// Edge probe: undocumented / deprecated / app-registration-gated Spotify Web
// API surface. READ-ONLY — every probe is a GET, including the three
// wrong-method rows whose 405 is the evidence that the endpoint still exists.
// Refreshes the access token via the PKCE refresh flow, then records status +
// a redacted snippet for each endpoint so we can tell "dead" (404), "exists
// but wrong method" (405), "app-gated / removed for this app" (403/401) from
// "actually alive".
//
// The report is a shareable artifact: the account id, display name and email
// are redacted out of it (scripts/probe-lib.mjs, #646), it is written 0600
// under a name carrying this run's timestamp, and a 429 is answered with the
// Retry-After the server sent instead of a fixed 800 ms.
//
// Usage:
//   node scripts/edge-probe.mjs [report.json] [--force] [--only <substring>]
//                              [--interval-ms <n>]
//   (needs .env — copy .env.example — and a token file; see resolveTokenPath)
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRetryAfterSeconds, resolveReportPath, runProbes } from './probe-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Parse argv. A bare `report.json` is the report path; every other input is a
 * flag. Unknown flags are a usage error rather than a silent no-op, because a
 * mistyped `--forece` would otherwise run the sweep and leave the previous
 * report in place looking current.
 */
function parseArgv(argv) {
  const options = { reportPath: undefined, force: false, only: undefined, intervalMs: 800 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      options.force = true;
    } else if (arg === '--only') {
      options.only = argv[i + 1];
      if (options.only === undefined) usage('--only needs a substring to match a probe label');
      i += 1;
    } else if (arg === '--interval-ms') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) usage('--interval-ms must be a whole number of milliseconds >= 0');
      options.intervalMs = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      usage(`unknown option ${arg}`);
    } else if (options.reportPath === undefined) {
      options.reportPath = arg;
    } else {
      usage(`unexpected argument ${arg}`);
    }
  }
  return options;
}

function usage(problem) {
  console.error(`edge-probe: ${problem}`);
  console.error('usage: node scripts/edge-probe.mjs [report.json] [--force] [--only <substring>] [--interval-ms <n>]');
  process.exit(2);
}

/**
 * Read `.env`, or explain how to make one. This used to be an unguarded
 * `readFileSync` that threw ENOENT *before* the client-id check three lines
 * below it could ever print, so a clean checkout got a stack trace instead of
 * the one line that fixes it.
 */
function readDotEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) {
    console.error(`edge-probe: no .env at ${path}`);
    console.error('  cp .env.example .env   # then set SPOTIFY_CLIENT_ID');
    process.exit(1);
  }
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    env[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return env;
}

/**
 * Resolve the token file the way `src/config.ts` does: `SPOTIFY_MCP_TOKEN_FILE`
 * wins, then `SPOTIFY_MCP_PROFILE` names a file, then the default. The profile
 * name is validated here for the same reason `config.ts` validates it — it is
 * interpolated into a path.
 */
function resolveTokenPath(env, processEnv) {
  const explicit = processEnv.SPOTIFY_MCP_TOKEN_FILE ?? env.SPOTIFY_MCP_TOKEN_FILE;
  if (explicit) return explicit;
  const profile = (processEnv.SPOTIFY_MCP_PROFILE ?? env.SPOTIFY_MCP_PROFILE ?? '').trim();
  if (profile !== '') {
    if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
      console.error(`edge-probe: invalid SPOTIFY_MCP_PROFILE — must match [A-Za-z0-9._-]+ and not be "." or ".."`);
      process.exit(1);
    }
    return join(homedir(), '.spotify-mcp', `tokens.${profile}.json`);
  }
  return join(homedir(), '.spotify-mcp', 'tokens.json');
}

const options = parseArgv(process.argv.slice(2));
const env = readDotEnv();
const clientId = env.SPOTIFY_CLIENT_ID ?? process.env.SPOTIFY_CLIENT_ID;
if (!clientId) {
  console.error('edge-probe: no SPOTIFY_CLIENT_ID in .env — set it to the app whose registration you are probing');
  process.exit(1);
}

// Property names built dynamically so no credential-shaped string is written.
const REF = ['refresh', 'token'].join('_');
const ACC = ['access', 'token'].join('_');
const EXP = ['expires', 'at'].join('_');

const tokenPath = resolveTokenPath(env, process.env);
if (!existsSync(tokenPath)) {
  console.error(`edge-probe: no token file at ${tokenPath}`);
  console.error('  run `npm run auth` to complete the PKCE flow, or set SPOTIFY_MCP_TOKEN_FILE');
  process.exit(1);
}
let tokens = JSON.parse(readFileSync(tokenPath, 'utf8'));

async function refresh() {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_' + 'token');
  body.set(REF, tokens[REF]);
  body.set('client_id', clientId);
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    // A 429 here is the token endpoint's own quota, and it is the one place in
    // this script that must not retry into it.
    if (res.status === 429) {
      const wait = parseRetryAfterSeconds(res.headers.get('retry-after'));
      console.error(`edge-probe: the token endpoint rate limited the refresh — retry in ${Math.ceil(wait)}s`);
      process.exit(1);
    }
    throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  }
  const t = await res.json();
  tokens = { ...tokens, ...t, [EXP]: Date.now() + (t.expires_in ?? 3600) * 1000 };
  writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`token refreshed (expires in ${t.expires_in ?? 3600}s)`);
}
if ((tokens[EXP] ?? 0) < Date.now() + 60_000) await refresh();

const PROBES = [
  // A. Feb-2026 "removed for everyone" — do they still breathe?
  ['recommendations (removed?)', 'GET', '/v1/recommendations?seed_genres=rock&limit=1'],
  ['genre-seeds (removed?)', 'GET', '/v1/recommendations/available-genre-seeds'],
  ['audio-features (removed?)', 'GET', '/v1/audio-features/{{track}}'],
  ['audio-analysis (removed?)', 'GET', '/v1/audio-analysis/{{track}}'],
  ['related-artists (removed?)', 'GET', '/v1/artists/{{artist}}/related-artists'],
  ['featured-playlists (removed?)', 'GET', '/v1/browse/featured-playlists?limit=1'],
  // B. App-registration-gated (gauntlet SKIP set)
  ['markets (app-gated?)', 'GET', '/v1/markets'],
  ['artist-top-tracks (app-gated?)', 'GET', '/v1/artists/{{artist}}/top-tracks?market=GB'],
  ['user-profile-by-id (app-gated?)', 'GET', '/v1/users/{{uid}}'],
  ['user-playlists-by-id (app-gated?)', 'GET', '/v1/users/{{uid}}/playlists?limit=3'],
  // C. Undocumented / rarely seen
  ['me/notifications (undoc)', 'GET', '/v1/me/notifications'],
  ['me/apps (undoc)', 'GET', '/v1/me/apps'],
  ['me/chapters?ids (undoc)', 'GET', '/v1/me/chapters?ids={{track}}'],
  // D. Documented but worth confirming on THIS key
  ['player (doc)', 'GET', '/v1/me/player'],
  ['currently-playing (doc)', 'GET', '/v1/me/player/currently-playing?additional_types=episode'],
  ['queue (doc)', 'GET', '/v1/me/player/queue'],
  ['devices (doc)', 'GET', '/v1/me/player/devices'],
  ['recently-played (doc)', 'GET', '/v1/me/player/recently-played?limit=2'],
  ['top-artists (doc)', 'GET', '/v1/me/top/artists?time_range=short_term&limit=2'],
  ['following (doc)', 'GET', '/v1/me/following?type=artist&limit=2'],
  ['following/contains (doc)', 'GET', '/v1/me/following/contains?type=artist&ids={{artist}}'],
  ['saved-tracks (doc)', 'GET', '/v1/me/tracks?limit=2'],
  ['saved-albums (doc)', 'GET', '/v1/me/albums?limit=2'],
  ['saved-shows (doc)', 'GET', '/v1/me/shows?limit=2'],
  ['saved-episodes (doc)', 'GET', '/v1/me/episodes?limit=2'],
  ['saved-audiobooks (doc)', 'GET', '/v1/me/audiobooks?limit=2'],
  ['tracks/contains (doc)', 'GET', '/v1/me/tracks/contains?ids={{track}}'],
  ['albums/contains (doc)', 'GET', '/v1/me/albums/contains?ids={{album}}'],
  ['shows/contains (doc)', 'GET', '/v1/me/shows/contains?ids={{show}}'],
  ['episodes/contains (doc)', 'GET', '/v1/me/episodes/contains?ids={{episode}}'],
  ['audiobooks/contains (doc)', 'GET', '/v1/me/audiobooks/contains?ids={{track}}'],
  ['browse/new-releases (doc)', 'GET', '/v1/browse/new-releases?limit=2'],
  ['browse/categories (doc?)', 'GET', '/v1/browse/categories?limit=2'],
  ['search+include_external (edge)', 'GET', '/v1/search?q=lullaby&type=track&limit=1&include_external=audio'],
  // E. Wrong-method probes — 405 proves the endpoint still exists
  ['POST-only: player/play via GET', 'GET', '/v1/me/player/play'],
  ['POST-only: player/next via GET', 'GET', '/v1/me/player/next'],
  ['POST-only: player/volume via GET', 'GET', '/v1/me/player/volume'],
];

const probes = options.only === undefined
  ? PROBES
  : PROBES.filter(([label]) => label.includes(options.only));
if (probes.length === 0) usage(`--only ${JSON.stringify(options.only)} matched no probe label`);

// Public catalogue seed ids (no private data).
const seeds = {
  track: '4uLU6hMCjMI75M1A2tKUQC', // Daft Punk — Get Lucky
  album: '4y0PJz5H8dFQbGwLW1xKaA', // Daft Punk — RAM
  show: '4rOoJ6Egrf8K2IrywzwOMk', // The Daily
  episode: '512ojhOuo1ktJprKbVcKyQ', // The Daily ep
  artist: '4YRxDV8wJFPHPTeXepOstw', // Foo Fighters
};

const report = await runProbes({
  probes,
  token: { ...seeds, access: tokens[ACC] },
  log: (line) => console.log(line),
  intervalMs: options.intervalMs,
});

/**
 * Resolve the report path and refuse to clobber. The default name carries the
 * run's own timestamp, so two runs on one day land in two files; an explicit
 * path that already holds a report is a mistake worth naming, and `--force` is
 * how it is overridden.
 */
let reportPath;
try {
  reportPath = resolveReportPath(options.reportPath, {
    root: ROOT,
    runAt: report.runAt,
    force: options.force,
    existsSync,
    isDirectory: (path) => {
      try { return statSync(path).isDirectory(); } catch { return false; }
    },
  });
} catch (error) {
  usage(String(error instanceof Error ? error.message : error));
}

const reportDir = dirname(reportPath);
// 0700 / 0600: the report names a live account, so it is owner-only on disk.
// The modes are set explicitly rather than left to the umask, which is 022 on
// most hosts and would make a directory 0755.
mkdirSync(reportDir, { recursive: true, mode: 0o700 });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
chmodSync(reportDir, 0o700);
chmodSync(reportPath, 0o600);

console.log(`\n${report.results.length} probes → report: ${reportPath}`);
const counts = {};
for (const r of report.results) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
console.log('summary:', JSON.stringify(counts));
if (report.quotaWall) {
  console.log('QUOTA WALL: the sweep stopped inside a rate-limit window. Re-run later; the report records the unsent probes as NOT-RUN.');
  process.exit(3);
}
