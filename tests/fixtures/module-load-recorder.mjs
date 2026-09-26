/**
 * ESM resolve hook that records every module the process actually loads (#906).
 *
 * The point of this file is that it observes the MODULE SYSTEM, not our own
 * bookkeeping. A test that wraps `module.load` in a spy and asserts the spy was
 * not called is asserting that our code called our own thunk — it would keep
 * passing if the thunk were bypassed by a static import somewhere else. This
 * hook sits below that: if `./tools/playlists.ts` is ever evaluated, its URL
 * lands in the record file, whatever asked for it.
 *
 * Runs on the loader thread, so it appends synchronously and shares no memory
 * with the main thread.
 */
import { appendFileSync } from 'node:fs';

let recordFile;

export async function initialize(data) {
  recordFile = data?.recordFile;
}

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (recordFile) {
    try {
      appendFileSync(recordFile, `${resolved.url}\n`);
    } catch {
      // A failed record must not break the module being loaded; the test fails
      // on a missing line, which is the honest signal.
    }
  }
  return resolved;
}
