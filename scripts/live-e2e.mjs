#!/usr/bin/env node
// Live end-to-end check against a real Spotify account.
// Prereqs: npm run build && npm run auth (tokens in ~/.spotify-mcp/tokens.json,
// which the harness COPIES into a throwaway home — see spawnHarnessServer)
// Usage: node scripts/live-e2e.mjs [SPOTIFY_CLIENT_ID]
//
// #1397: this used to spawn with no `env` at all, so the server inherited the
// developer's real $HOME and its local stores. The spawn is now unconditional and
// hermetic; see scripts/hermetic-home.mjs.
// #644: the spawn, the JSONL RPC loop, the handshake and the timeout policy all
// moved to scripts/lib/mcp-client.mjs, and the preconditions run before the
// spawn. Previously a missing `.env` made node abort with exit 9 before the
// server existed, and this script reported the only thing it could —
// `Error: timeout: initialize` — 30s later. It now says which file is missing
// and what to run.
import { connect } from './lib/mcp-client.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const client = await connect({ label: 'live-e2e', name: 'live-e2e', cwd: ROOT });
const { rpc } = client;

const text = (r) => r.content.map((c) => c.text).join('\n');
const results = [];
async function step(name, tool, args) {
  try {
    const r = await rpc('tools/call', { name: tool, arguments: args });
    const out = text(r).slice(0, 160).replace(/\n/g, ' | ');
    results.push([name, 'PASS', out]);
  } catch (e) {
    results.push([name, 'FAIL', e.message.slice(0, 160)]);
  }
}
await step('get_me', 'get_me', {});
await step('search', 'search', { query: 'daft punk', limit: 3 });
await step('get_top_tracks (user)', 'get_top_tracks', {});
await step('get_recently_played (user)', 'get_recently_played', {});
await step('get_saved_tracks (user)', 'get_saved_tracks', { limit: 5 });
await step('get_user_playlists (user)', 'get_user_playlists', {});
await step('get_followed_artists (user)', 'get_followed_artists', {});
await step('get_now_playing / devices', 'get_devices', {});

console.log('\n=== LIVE E2E ===');
for (const [n, s, o] of results) console.log(`${s.padEnd(5)} ${n.padEnd(30)} ${o}`);
const failed = results.filter(([, s]) => s === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
client.close();
process.exit(failed ? 1 : 0);
