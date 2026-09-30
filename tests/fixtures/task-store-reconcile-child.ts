/**
 * Child process for the #1635 guard tests.
 *
 * Run as: `node --import tsx <this file> <storeDir> <optOutValue|->`
 *
 * Constructs a `PersistentTaskStore` and reports, on stdout as one JSON line,
 * what the constructor did to the record set. The point of the child is
 * `HOME`: `tests/helpers/hermetic.ts` redirects `HOME` to a temp root, so an
 * in-process test can never construct a store that resolves inside a home the
 * guard will call real — the sandbox and the home are the same directory, and
 * the guard is right to reconcile it. Only a process that was *not* redirected
 * can exercise the branch that refuses.
 *
 * So this child is spawned with `HOME` and `USERPROFILE` pointed at a
 * throwaway root and no hermetic helper imported. The guard then sees a store
 * under its own `homedir()` and must decline to reconcile it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { PersistentTaskStore } from '../../src/tasks.ts';

const dir = process.argv[2];
const optOut = process.argv[3];

if (optOut && optOut !== '-') {
  process.env.SPOTIFY_MCP_ALLOW_REAL_HOME_STORES = optOut;
} else {
  delete process.env.SPOTIFY_MCP_ALLOW_REAL_HOME_STORES;
}

const warnings: string[] = [];
process.on('warning', (w: Error) => warnings.push(String(w.message)));

new PersistentTaskStore(dir);

// `process.on('warning')` is deferred to a later tick, so a child that writes
// its report synchronously exits first and the warnings are never collected --
// which reads as "the guard stayed silent" when it in fact declined. Let the
// loop drain before reporting, or the caller cannot tell those two apart.
await new Promise<void>((resolve) => setImmediate(resolve));

const files = readdirSync(dir).sort();
const report = {
  files,
  quarantined: files.filter((f) => f.endsWith('.corrupt')),
  workingStatus: (() => {
    const file = join(dir, 'working.json');
    if (!existsSync(file)) return null;
    return (JSON.parse(readFileSync(file, 'utf8')) as { task: { status: string } }).task.status;
  })(),
  warnings,
};
process.stdout.write(`${JSON.stringify(report)}\n`);
