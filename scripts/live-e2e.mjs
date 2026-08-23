#!/usr/bin/env node
// Live end-to-end check against a real Spotify account.
// Prereqs: npm run build && npm run auth (tokens in ~/.spotify-mcp/tokens.json)
// Usage: node scripts/live-e2e.mjs [SPOTIFY_CLIENT_ID]
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const child = spawn('node', ['--env-file=.env', 'dist/index.js'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['pipe', 'pipe', 'inherit'] });
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
function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout: ${method}`))), 30000);
  });
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-e2e', version: '1.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

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
child.kill();
process.exit(failed ? 1 : 0);
