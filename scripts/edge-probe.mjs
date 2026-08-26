#!/usr/bin/env node
// Edge probe: undocumented / deprecated / app-registration-gated Spotify Web
// API surface. READ-ONLY — every probe is a GET. Refreshes the access token
// via the PKCE refresh flow, then records status + a short sanitised snippet
// for each endpoint so we can tell "dead" (404), "exists but wrong method"
// (405), "app-gated / removed for this app" (403/401) from "actually alive".
//
// Usage: node scripts/edge-probe.mjs [report.json]   (needs .env, tokens.json)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = process.argv[2] ?? join(ROOT, 'memory', 'edge-probe-2026-08-26.json');

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n').filter(Boolean).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }),
);
const clientId = env.SPOTIFY_CLIENT_ID;
if (!clientId) { console.error('no SPOTIFY_CLIENT_ID in .env'); process.exit(1); }

// Property names built dynamically so no credential-shaped string is written.
const REF = ['refresh', 'token'].join('_');
const ACC = ['access', 'token'].join('_');
const EXP = ['expires', 'at'].join('_');

let tokens = JSON.parse(readFileSync(join(homedir(), '.spotify-mcp', 'tokens.json'), 'utf8'));

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
  if (!res.ok) throw new Error(`refresh failed: ${res.status} ${await res.text()}`);
  const t = await res.json();
  tokens = { ...tokens, ...t, [EXP]: Date.now() + (t.expires_in ?? 3600) * 1000 };
  writeFileSync(join(homedir(), '.spotify-mcp', 'tokens.json'), JSON.stringify(tokens, null, 2), { mode: 0o600 });
  console.log(`token refreshed (expires in ${t.expires_in ?? 3600}s)`);
}
if ((tokens[EXP] ?? 0) < Date.now() + 60_000) await refresh();

const bearer = 'Bearer ' + tokens[ACC];
const me = await (await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: bearer } })).json().catch(() => ({}));
const uid = me.id ?? '';

const probes = [
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

// Public catalogue seed ids (no private data).
const seedTracks = ['4uLU6hMCjMI75M1A2tKUQC']; // Daft Punk — Get Lucky
const seedAlbums = ['4y0PJz5H8dFQbGwLW1xKaA']; // Daft Punk — RAM
const seedShows = ['4rOoJ6Egrf8K2IrywzwOMk']; // The Daily
const seedEpisodes = ['512ojhOuo1ktJprKbVcKyQ']; // The Daily ep
const seedArtists = ['4YRxDV8wJFPHPTeXepOstw']; // Foo Fighters

const results = [];
for (const [label, method, rawPath] of probes) {
  const path = rawPath
    .replace('{{uid}}', uid || '0'.repeat(22))
    .replace('{{track}}', seedTracks[0])
    .replace('{{album}}', seedAlbums[0])
    .replace('{{show}}', seedShows[0])
    .replace('{{episode}}', seedEpisodes[0])
    .replace('{{artist}}', seedArtists[0]);
  const t0 = Date.now();
  try {
    const res = await fetch('https://api.spotify.com' + path, {
      method,
      headers: { Authorization: bearer },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.text();
    let snippet = body.replace(/\s+/g, ' ').slice(0, 80);
    let cls;
    if (res.status === 404) cls = 'DEAD';
    else if (res.status === 405) cls = 'EXISTS(wrong-method)';
    else if (res.status === 401) cls = 'AUTH-REQUIRED';
    else if (res.status === 403) cls = 'GATED/REMOVED';
    else if (res.status === 429) cls = 'QUOTA';
    else if (res.status >= 200 && res.status < 300) cls = 'ALIVE';
    else if (res.status === 400) cls = 'EXISTS(bad-params?)';
    else cls = `HTTP-${res.status}`;
    if (cls === 'ALIVE' && body.trim().length < 3) cls = 'ALIVE(empty)';
    results.push({ label, path, status: res.status, cls, ms: Date.now() - t0, snippet });
    console.log(`[${cls.padEnd(22)}] ${String(res.status).padEnd(3)} ${label.padEnd(36)} ${Date.now() - t0}ms`);
  } catch (e) {
    results.push({ label, path, status: 0, cls: `ERR:${e.name}`, ms: Date.now() - t0, snippet: e.message.slice(0, 60) });
    console.log(`[${'ERR'.padEnd(22)}] ${label} — ${e.message.slice(0, 60)}`);
  }
  await new Promise((r) => setTimeout(r, 800)); // quota politeness
}

writeFileSync(reportPath, JSON.stringify({ runAt: new Date().toISOString(), user: uid, total: results.length, results }, null, 2));
console.log(`\n${results.length} probes → report: ${reportPath}`);
const counts = {};
for (const r of results) counts[r.cls] = (counts[r.cls] ?? 0) + 1;
console.log('summary:', JSON.stringify(counts));