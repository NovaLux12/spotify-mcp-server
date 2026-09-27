#!/usr/bin/env node
// Live end-to-end check against a real Spotify account.
// Prereqs: npm run build && npm run auth (tokens in ~/.spotify-mcp/tokens.json,
// which the harness COPIES into a throwaway home — see spawnHarnessServer)
// Usage: node scripts/live-e2e.mjs
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
//
// #645 (this file):
//
//   1. NO POSITIONAL ARGUMENT. The old header documented
//      `node scripts/live-e2e.mjs [SPOTIFY_CLIENT_ID]`, and `process.argv` was
//      never read anywhere in the file, so the argument was silently ignored —
//      a maintainer who passed a client id got the one in their `.env` and had
//      no way to know. It is deleted rather than implemented, because the
//      environment variable already IS the mechanism, by three independent
//      routes that need no new code:
//        - the server reads it from `process.env` and nowhere else
//          (src/client.ts, src/auth.ts);
//        - `spawnHarnessServer` copies the parent environment into the sandbox
//          and strips only `SPOTIFY_MCP_*`, so an exported SPOTIFY_CLIENT_ID
//          reaches the child (scripts/hermetic-home.mjs);
//        - the shared preflight already accepts EITHER a `.env` file OR
//          `env.SPOTIFY_CLIENT_ID` (scripts/lib/preflight.mjs, `addClientId`),
//          and the child loads `.env` via `--env-file-if-exists=.env`.
//      A third path would be a value that has to be threaded from argv into the
//      child environment, able to disagree with the one the server actually
//      reads. Delete the doc line; keep the env var.
//   2. AUTH IS ITS OWN STATUS. Every step below is a USER-DATA read, so an
//      expired token fails all of them at once. Counting that as eight
//      functional failures sent maintainers after a server regression that does
//      not exist. AUTH is now classified separately, excluded from the pass
//      ratio, and printed with the command that fixes it — while still exiting
//      non-zero, because a run that exercised nothing is not a pass.
//   3. The reported surface is forced to `all`. Three of the eight steps name
//      tools that are NOT in the default toolset (`get_me`,
//      `get_top_tracks`, `get_recently_played` are in `catalog` and
//      `personalization`; the default is core/resources/prompts since #889).
//      Before this they could never pass, and because a missing tool comes back
//      as a RESOLVED `isError` result rather than a rejection, the old
//      try/catch scored all three as PASS. Three permanent silent passes, in a
//      script whose whole job is to catch a broken server.
import { connect } from './lib/mcp-client.mjs';
import { STATUS, classifyToolResult, summarizeRun } from './lib/gate-decision.mjs';

const ROOT = new URL('..', import.meta.url).pathname;

/** See the header: the steps name tools outside the default toolset. */
const TOOLSETS = process.env.SPOTIFY_MCP_TOOLSETS ?? 'all';

const client = await connect({
  label: 'live-e2e',
  name: 'live-e2e',
  cwd: ROOT,
  env: { SPOTIFY_MCP_TOOLSETS: TOOLSETS },
});
const { rpc } = client;

const results = [];

/**
 * One step, classified rather than guessed.
 *
 * The old version pushed PASS for any resolved call and FAIL for any rejection.
 * Neither matched reality: the server's error boundary turns a handler's throw
 * into a NORMAL result carrying `isError: true`, so a failed tool was a PASS,
 * and the only thing that ever produced a FAIL was a harness-level failure.
 */
async function step(name, tool, args) {
  let row;
  try {
    const r = await rpc('tools/call', { name: tool, arguments: args });
    row = classifyToolResult({ result: r, name });
  } catch (e) {
    row = classifyToolResult({ error: e, name });
  }
  results.push(row);
  return row;
}

await step('get_me', 'get_me', {});
await step('search', 'search', { query: 'daft punk', limit: 3 });
await step('get_top_tracks (user)', 'get_top_tracks', {});
await step('get_recently_played (user)', 'get_recently_played', {});
await step('get_saved_tracks (user)', 'get_saved_tracks', { limit: 5 });
await step('get_user_playlists (user)', 'get_user_playlists', {});
await step('get_followed_artists (user)', 'get_followed_artists', {});
await step('get_now_playing / devices', 'get_devices', {});

const summary = summarizeRun(results);

console.log(`\n=== LIVE E2E (SPOTIFY_MCP_TOOLSETS=${TOOLSETS}) ===`);
for (const r of results) {
  const detail = r.detail.slice(0, 160).replace(/\n/g, ' | ');
  console.log(`${r.status.padEnd(5)} ${r.name.padEnd(30)} ${detail}`);
}

// The ratio counts only the rows whose contract is to return data, and says so
// when it has no denominator: a denominator that silently included the rows it
// could not test is how an expired token read as "0/8 passed" instead of "no
// tool was exercised".
console.log(`\n${summary.ratio} passed (functional); ${summary.tested}/${summary.total} tested`);
if (summary.gated > 0) console.log(`${summary.gated} gated — app-registration-gated, not a regression (src/gating.ts)`);
if (summary.auth > 0) console.log(`${summary.auth} auth — excluded from the ratio: ${summary.authNote.replace(/^AUTH — /, '')}`);
if (summary.failed > 0) console.log(`${summary.failed} functional failure(s)`);

client.close();
process.exit(summary.exitCode);
