#!/usr/bin/env node
// Tool-level gate check: spawn the real server, discover tools, and call the
// candidates that sit on the app-registration-gated surface. Read-only args.
//
// #1397: this used to spawn with no `env` at all, so the server inherited the
// developer's real $HOME and its local stores. The spawn is now unconditional and
// hermetic; see scripts/hermetic-home.mjs.
// #644: the spawn, the JSONL RPC loop, the handshake and the timeout policy
// moved to scripts/lib/mcp-client.mjs, which also runs the preconditions
// before the spawn. This script previously held its own 45s timeout and its own
// hard-coded protocol revision, both now the shared ones.
import { connect } from './lib/mcp-client.mjs';

const client = await connect({
  label: 'tool-gate-check',
  name: 'tool-gate-check',
  cwd: new URL('..', import.meta.url).pathname,
});
const { rpc } = client;

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
  // #638: `get_categories` / `get_category_playlists` were deleted with
  // `GET /browse/categories*`, and `check_saved_items` with
  // `GET /me/{type}s/contains` — no endpoint serves either any more, so there
  // is nothing to probe. `check_in_library` is the surviving read on the
  // unified path; it is listed below unchanged.
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
client.close();
process.exit(0);