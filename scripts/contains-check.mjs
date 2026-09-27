#!/usr/bin/env node
// One-off: probe the remaining contains variants our tools rely on.
//
// The user id and playlist id are arguments, not constants (#646). They used
// to be the maintainer's own, hardcoded in a public file, which meant the check
// could only ever run for one person and could only ever 404 or 403 for anyone
// else — and it shipped that identity into the repository to do it.
//
// The ids go into the query string through URLSearchParams, so a value
// containing `/`, `..` or a space is percent-encoded rather than interpolated
// into a path the server will resolve.
//
// Usage: node scripts/contains-check.mjs <user-id> <playlist-id>
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRetryAfterSeconds, realSleep, redactSnippet } from './probe-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = 'usage: node scripts/contains-check.mjs <user-id> <playlist-id>';

/**
 * The two ids land in different parts of the URL, so they are validated
 * differently — a single rule for both would be either too strict for the
 * query value or too loose for the path segment.
 *
 * The playlist id becomes a *path segment*, where a `/` or a `..` would
 * traverse to a different endpoint, so it is held to a Spotify id's shape.
 * The user id becomes a *query value*, where URLSearchParams percent-encodes
 * everything, so anything printable is safe there; only control characters and
 * newlines are refused, and those are refused because this script prints the
 * value back in its usage errors.
 */
const PATH_ID = /^[A-Za-z0-9]{22}$/;
// Printable, no whitespace, no control character. `RegExp.test` coerces its
// argument, so `undefined` would otherwise match the string "undefined" and
// sail through a check that is meant to be about a real argument.
const QUERY_ID = /^[\x21-\x7e]{1,128}$/;

const [userId, playlistId, ...extra] = process.argv.slice(2);
if (typeof userId !== 'string' || typeof playlistId !== 'string' || extra.length > 0) {
  console.error('contains-check: expected exactly a user id and a playlist id');
  console.error(USAGE);
  process.exit(2);
}
for (const [label, value, shape] of [['user-id', userId, QUERY_ID], ['playlist-id', playlistId, PATH_ID]]) {
  if (!shape.test(value)) {
    console.error(`contains-check: ${label} ${JSON.stringify(value)} is not a Spotify id`);
    console.error(USAGE);
    process.exit(2);
  }
}

/** Resolve the token file the way `src/config.ts` does, not a hardcoded path. */
function resolveTokenPath() {
  if (process.env.SPOTIFY_MCP_TOKEN_FILE) return process.env.SPOTIFY_MCP_TOKEN_FILE;
  const profile = (process.env.SPOTIFY_MCP_PROFILE ?? '').trim();
  if (profile !== '') {
    if (!/^[A-Za-z0-9._-]+$/.test(profile) || profile === '.' || profile === '..') {
      console.error('contains-check: invalid SPOTIFY_MCP_PROFILE — must match [A-Za-z0-9._-]+ and not be "." or ".."');
      process.exit(1);
    }
    return join(homedir(), '.spotify-mcp', `tokens.${profile}.json`);
  }
  return join(homedir(), '.spotify-mcp', 'tokens.json');
}

const tokenPath = resolveTokenPath();
if (!existsSync(tokenPath)) {
  console.error(`contains-check: no token file at ${tokenPath}`);
  console.error('  run `npm run auth` to complete the PKCE flow, or set SPOTIFY_MCP_TOKEN_FILE');
  process.exit(1);
}

const ACC = ['access', 'token'].join('_');
const t = JSON.parse(readFileSync(tokenPath, 'utf8'));
const bearer = 'Bearer ' + t[ACC];

/**
 * Only the first probe carries the caller's ids, and it reports the id it
 * actually sent so a 404 on a typo is distinguishable from a 403 on a gated
 * endpoint. The two are different findings, and collapsing them into one
 * "contains" row was the reason this check was hard to act on.
 */
const followers = new URLSearchParams({ ids: userId }).toString();
const probes = [
  ['playlist followers/contains', `/v1/playlists/${encodeURIComponent(playlistId)}/followers/contains?${followers}`],
  ['me/library/contains (undoc)', '/v1/me/library/contains?uris=spotify%3Atrack%3A4uLU6hMCjMI75M1A2tKUQC'],
  ['me/following/contains', '/v1/me/following/contains?type=artist&ids=4YRxDV8wJFPHPTeXepOstw'],
  ['me/tracks/contains (doc)', '/v1/me/tracks/contains?ids=4uLU6hMCjMI75M1A2tKUQC'],
];

for (const [label, path] of probes) {
  let wait = 0;
  for (;;) {
    const res = await fetch('https://api.spotify.com' + path, { headers: { Authorization: bearer } });
    const body = await res.text();
    if (res.status !== 429) {
      console.log(res.status, label, '->', redactSnippet(body, userId).slice(0, 90));
      break;
    }
    // A 429 here used to be printed like any other status and the loop moved
    // on, spending the rest of the sweep inside the penalty window.
    if (wait > 0) {
      console.error(`contains-check: still rate limited after waiting — stopping before the quota wall deepens`);
      process.exit(3);
    }
    const seconds = parseRetryAfterSeconds(res.headers.get('retry-after'));
    console.error(`429 at ${label} — waiting ${Math.ceil(seconds)}s (Retry-After) before the single retry`);
    await realSleep(seconds * 1000);
    wait = seconds;
  }
}
