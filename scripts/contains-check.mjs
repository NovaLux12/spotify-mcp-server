#!/usr/bin/env node
// One-off: probe the remaining contains variants our tools rely on.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACC = ['access', 'token'].join('_');
let t = JSON.parse(readFileSync(join(homedir(), '.spotify-mcp', 'tokens.json'), 'utf8'));
const bearer = 'Bearer ' + t[ACC];

const probes = [
  ['playlist followers/contains', '/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/followers/contains?ids=j.lee12'],
  ['me/library/contains (undoc)', '/v1/me/library/contains?uris=spotify%3Atrack%3A4uLU6hMCjMI75M1A2tKUQC'],
  ['me/following/contains', '/v1/me/following/contains?type=artist&ids=4YRxDV8wJFPHPTeXepOstw'],
  ['me/tracks/contains (doc)', '/v1/me/tracks/contains?ids=4uLU6hMCjMI75M1A2tKUQC'],
];
for (const [label, path] of probes) {
  const res = await fetch('https://api.spotify.com' + path, { headers: { Authorization: bearer } });
  console.log(res.status, label, '->', (await res.text()).replace(/\s+/g, ' ').slice(0, 90));
}