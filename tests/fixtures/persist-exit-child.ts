/**
 * Child process for the #1266 exit-flush and #1279 hard-kill tests.
 *
 * Makes ONE catalog read with persistence on, so the controller schedules a
 * debounced save, and then terminates a chosen way while that 250 ms window is
 * still open. The parent then inspects the cache file to see whether the
 * pending save survived.
 *
 * This exists as a real process because the defect is about termination: an
 * in-process test could only assert that a method was called, not that the
 * signal/`exit()` path actually let the write reach disk.
 *
 * Env (all supplied by the parent, all under a mkdtemp dir):
 *   SPOTIFY_MCP_PERSIST_EXIT_MODE  'exit' | 'uncaught' | a signal name
 *                                  ('sigterm', 'sighup', 'sigquit', 'sigkill')
 *   SPOTIFY_MCP_DATA_DIR           directory for cache.json
 *   SPOTIFY_MCP_TOKEN_FILE         token file
 */

import { SpotifyClient } from '../../src/client.js';

const mode = process.env.SPOTIFY_MCP_PERSIST_EXIT_MODE ?? 'exit';

// One catalog read, so `scheduleSave` arms the debounce. `/tracks/{id}` is on
// the persistence allowlist, which is what makes this read persistable at all.
globalThis.fetch = (async () =>
  new Response(JSON.stringify({ id: 'tr1', name: 'Track One' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;

const client = new SpotifyClient();
await client.get('/tracks/tr1', {});

// Tell the parent the read is cached and the debounce is pending, so it can
// signal inside the window rather than racing a sleep. #1279 additionally needs
// the marker to be armed before this line, which it is: `scheduleSave` writes it
// before it arms the timer, and the read has already returned by now.
process.stdout.write('cached\n');

if (mode === 'exit') {
  // The `exit` event cannot await, so an async flush started here would be
  // discarded. Whatever survives this call is what the fix must have made
  // synchronous enough to land.
  process.exit(0);
} else if (mode === 'uncaught') {
  // An uncaught throw unwinds straight to the exit path with no chance to
  // await. Node runs `exit` handlers synchronously and nothing else.
  throw new Error('deliberate uncaught throw for the #1266 exit test');
}
// A signal name: the parent sends it inside the debounce window. 'sigkill' is
// included deliberately — it is the one case where NO JavaScript runs, so the
// child dies with the write unflushed and only the marker survives.
setTimeout(() => {
  process.stderr.write('child: no signal arrived\n');
}, 5000);
