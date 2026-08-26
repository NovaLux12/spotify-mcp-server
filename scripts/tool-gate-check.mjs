#!/usr/bin/env node
// Tool-level gate check: spawn the real server, discover tools, and call the
// candidates that sit on the app-registration-gated surface. Read-only args.
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
function rpc(method, params, timeoutMs = 45000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error)).slice(0, 400)) : res(m.result)));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => pending.has(id) && (pending.delete(id), rej(new Error(`timeout: ${method}`))), timeoutMs);
  });
}

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tool-gate-check', version: '1.0.0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const { tools } = await rpc('tools/list', {});
console.log(`tools/list: ${tools.length}`);

// seed ids
const me = await rpc('tools/call', { name: 'get_me', arguments: { response_format: 'json' } }).then((r) => r.structuredContent ?? {}).catch(() => ({}));
const search = await rpc('tools/call', { name: 'search', arguments: { query: 'daft punk', types: ['track'], limit: 1, response_format: 'json' } }).then((r) => r.structuredContent ?? {}).catch(() => ({}));
const trackId = search?.tracks?.items?.[0]?.id ?? '4uLU6hMCjMI75M1A2tKUQC';
const artistId = search?.tracks?.items?.[0]?.artists?.[0]?.id ?? '4YRxDV8wJFPHPTeXepOstw';
const uid = me.id ?? '';

// The gated-family tools (name -> minimal args)
const candidates = [
  ['get_available_markets', {}],
  ['get_artist_top_tracks', { id: artistId }],
  ['get_user_profile', { user_id: uid }],
  ['get_user_playlists_by_id', { user_id: uid }],
  ['get_categories', { limit: 3 }],
  ['get_category_playlists', { category_id: 'toplists' }],
  ['check_in_library', { type: 'track', ids: [trackId] }],
  ['are_you_following_artist', { ids: [artistId] }],
];
const names = new Set(candidates.map(([n]) => n));
const known = new Set(tools.map((t) => t.name));
for (const [n] of candidates) if (!known.has(n)) console.log(`!! tool not registered: ${n}`);

for (const [name, args] of candidates) {
  if (!known.has(name)) continue;
  const t0 = Date.now();
  try {
    const r = await rpc('tools/call', { name, arguments: args });
    const txt = (r.content ?? []).map((c) => c.text ?? '').join(' ').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`[PASS] ${name.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${txt}`);
  } catch (e) {
    console.log(`[FAIL] ${name.padEnd(30)} ${String(Date.now() - t0).padStart(5)}ms  ${String(e).slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, 700));
}
child.kill();
process.exit(0);