/**
 * #703 — the mutation ledger had a byte cap and no retention.
 *
 * Three properties, each observed through the real write path or the real
 * purge path rather than through a helper the implementation agrees with:
 *
 *   1. A ROW cap. Bytes stop a file growing without limit; they do not say
 *      how many dated records that is, so a user could not answer "how much
 *      of my history is still here" and nothing bounded the count itself.
 *   2. An AGE cap, applied over BOTH generations. The rotated
 *      `mutations.jsonl.1` holds the OLDEST records, so a prune that only
 *      touched the live file would expire nothing — which is why the retention
 *      fixtures here seed the archive as well as the live file.
 *   3. A purge that reaches the archive. `logout` erasing the live ledger and
 *      reporting a clean sweep while half the trail stayed on disk is the
 *      outcome this issue is about.
 *
 * ## The clock (#703)
 *
 * The age cap is tested against a clock the test holds, not one it waits on.
 * `pruneHistoryLedger(env, tokenFile, now)` takes the instant, and the
 * fixtures are real JSONL lines on disk whose `ts` is genuinely older than
 * the window — seeded relative to a PINNED_NOW, not relative to "now" at
 * assert time. Nothing here can pass by asserting on a timestamp that was
 * fresh when it was written, because the oldest fixture record is 200 days
 * old the moment it is written and the assertion is that it is GONE.
 *
 * ## Hermeticity
 *
 * `helpers/hermetic.js` is imported FIRST, before any src import, so the
 * default `~/.spotify-mcp` location resolves to a temp root for the whole
 * process. A probe that imports server code first writes into the real
 * directory, and every store here is additionally pointed at a per-test
 * temp dir, so even a resolver that ignores HOME cannot reach user data.
 */

import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetHistoryWriteState,
  appendHistory,
  DEFAULT_HISTORY_MAX_ROWS,
  DEFAULT_HISTORY_RETENTION_DAYS,
  historyLedgerPaths,
  historyLedgerStats,
  historyMaxRows,
  historyRetentionDays,
  historyRetentionMs,
  pruneHistoryLedger,
  pruneHistoryLedgers,
  readHistory,
} from '../src/history.js';

const DAY_MS = 86_400_000;

/** The instant every age assertion is made against. */
const PINNED_NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

let ROOT = '';

/**
 * Point every history store at a fresh temp dir and reset the process-scoped
 * ledger-shape cache, so one test's measured row count can never be handed to
 * the next.
 */
async function sandbox(env: Record<string, string> = {}): Promise<{ dir: string; ledger: string }> {
  ROOT = await mkdtemp(join(tmpdir(), 'spotify-mcp-703-'));
  const dir = join(ROOT, 'history');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  process.env.SPOTIFY_MCP_HISTORY_DIR = dir;
  process.env.SPOTIFY_MCP_HISTORY = '1';
  process.env.SPOTIFY_MCP_TOKEN_FILE = join(ROOT, 'tokens.json');
  for (const key of [
    'SPOTIFY_MCP_HISTORY_MAX_ROWS',
    'SPOTIFY_MCP_HISTORY_MAX_BYTES',
    'SPOTIFY_MCP_HISTORY_RETENTION_DAYS',
  ]) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  __resetHistoryWriteState();
  return { dir, ledger: join(dir, 'mutations.jsonl') };
}

/** A record line as the writer would have written it, dated `daysOld` before PINNED_NOW. */
function line(who: string, daysOld: number): string {
  return (
    JSON.stringify({
      ts: new Date(PINNED_NOW - daysOld * DAY_MS).toISOString(),
      who,
      method: 'PUT',
      path: '/playlists/{id}/items',
    }) + '\n'
  );
}

async function seed(ledger: string, lines: string[], archive = false): Promise<void> {
  await writeFile(archive ? `${ledger}.1` : ledger, lines.join(''), { encoding: 'utf8', mode: 0o600 });
}

/** Every record the ledger exposes, across both generations, oldest first. */
async function rows(ledger: string): Promise<Array<{ who?: string }>> {
  return readHistory({ file: ledger, limit: 10_000 });
}

async function whoList(ledger: string): Promise<string[]> {
  return (await rows(ledger)).map((r) => String(r.who));
}

// ---------------------------------------------------------------- the row cap

test('appending past the row cap leaves exactly the newest rows', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '10' });
  for (let i = 1; i <= 25; i++) {
    await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: `tool-${i}` }, DEFAULT_TOKEN_FILE);
  }
  const kept = await whoList(ledger);
  assert.equal(kept.length, 10, `the cap must bound the row count, got ${kept.length}`);
  assert.deepEqual(
    kept,
    Array.from({ length: 10 }, (_, i) => `tool-${16 + i}`),
    'the survivors must be the NEWEST rows, oldest dropped',
  );
  assert.equal(kept.includes('tool-1'), false, 'the oldest row must be gone');
});

test('the row cap holds across the rotated generation, not just the live file', async () => {
  // Rotation on, and loose enough that the ledger holds MORE rows than the cap
  // allows before pruning (2 x 1200 B is ~17 of these lines). A prune that read
  // one file would leave the other over the cap.
  const { ledger } = await sandbox({
    SPOTIFY_MCP_HISTORY_MAX_ROWS: '10',
    SPOTIFY_MCP_HISTORY_MAX_BYTES: '1200',
  });
  for (let i = 1; i <= 60; i++) {
    await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: `tool-${i}` }, DEFAULT_TOKEN_FILE);
  }
  const stats = await historyLedgerStats(process.env, DEFAULT_TOKEN_FILE);
  assert.ok(
    stats.archive_bytes > 0,
    `precondition: rotation must have produced an archive, got ${stats.archive_bytes} B`,
  );
  assert.equal(stats.rows, 10, `rows across BOTH generations must be capped, got ${stats.rows}`);
  assert.equal(stats.max_rows, 10);
  assert.deepEqual(
    (await rows(ledger)).map((r) => String(r.who)),
    Array.from({ length: 10 }, (_, i) => `tool-${51 + i}`),
  );
});

test('the cap is a bound and not a one-off rewrite: it still holds later', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '4' });
  for (let i = 1; i <= 30; i++) {
    await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: `tool-${i}` }, DEFAULT_TOKEN_FILE);
  }
  // Far past the cap, in a process that has long since re-measured: the last
  // append is the one the assertion is about, not the eleventh.
  assert.equal((await rows(ledger)).length, 4);
  assert.equal((await whoList(ledger)).at(-1), 'tool-30', 'the newest row must survive');
});

test('a prune leaves the ledger owner-only and drops no temp file', async () => {
  const { dir, ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '3' });
  for (let i = 1; i <= 9; i++) {
    await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: `tool-${i}` }, DEFAULT_TOKEN_FILE);
  }
  const mode = (await stat(ledger)).mode & 0o777;
  assert.equal(mode, 0o600, `the rewritten ledger must stay owner-only, got 0${mode.toString(8)}`);
  const litter = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(litter, [], `the prune left temp files behind: ${litter.join(', ')}`);
});

// ------------------------------------------------------------- the age cap

test('records past the retention window are dropped, oldest first', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '90' });
  await seed(ledger, [line('ancient', 200), line('old', 120), line('recent', 5)]);

  const result = await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);

  assert.deepEqual(await whoList(ledger), ['recent'], 'only the in-window record may survive');
  assert.equal(result.expired, 2, 'both out-of-window records must be reported as expired');
  assert.equal(result.rows_before, 3);
  assert.equal(result.rows_after, 1);
});

test('RETENTION_DAYS=0 disables age pruning entirely', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '0' });
  await seed(ledger, [line('ancient', 200), line('old', 120), line('recent', 5)]);

  const result = await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);

  assert.deepEqual(
    await whoList(ledger),
    ['ancient', 'old', 'recent'],
    'no time-based pruning may happen when the window is 0',
  );
  assert.equal(result.expired, 0);
  assert.equal(historyRetentionDays(process.env), 0);
  assert.equal(historyRetentionMs(process.env), Number.POSITIVE_INFINITY);
});

test('the append path enforces the age cap, not only the exported prune', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '90' });
  await seed(ledger, [line('ancient', 200), line('old', 120)]);

  await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: 'fresh' }, DEFAULT_TOKEN_FILE);

  assert.deepEqual(
    await whoList(ledger),
    ['fresh'],
    'an append is the moment the ledger is re-checked, so the stale rows must be gone',
  );
});

test('the age cap reaches the rotated generation, which is where the oldest rows live', async () => {
  // The failure this pins: a prune that reads only `mutations.jsonl` expires
  // nothing, because rotation puts the OLD records in `mutations.jsonl.1`.
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '90' });
  await seed(ledger, [line('archived-ancient', 300)], true);
  await seed(ledger, [line('live-fresh', 1)]);

  await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: 'newest' }, DEFAULT_TOKEN_FILE);

  const kept = await whoList(ledger);
  assert.equal(kept.includes('archived-ancient'), false, 'the archive must be pruned too');
  assert.deepEqual(kept, ['live-fresh', 'newest']);
});

test('a record with no readable ts is not expired — but is still capped', async () => {
  // The receipts precedent, applied to the ledger: an unknown age is not a
  // verdict, so a hand-written or pre-`ts` line is kept rather than silently
  // discarded. The row cap is what bounds it.
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '1' });
  await writeFile(ledger, '{"who":"hand-written"}\n', { encoding: 'utf8', mode: 0o600 });

  await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);
  assert.deepEqual(await whoList(ledger), ['hand-written'], 'an undated line must not be expired');

  process.env.SPOTIFY_MCP_HISTORY_MAX_ROWS = '1';
  __resetHistoryWriteState();
  await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: 'newer' }, DEFAULT_TOKEN_FILE);
  await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: 'newest' }, DEFAULT_TOKEN_FILE);
  const kept = await whoList(ledger);
  assert.equal(kept.length, 1, 'the row cap still bounds an undated ledger');
  assert.equal(kept[0], 'newest');
});

test('an unusable retention value keeps the default rather than expiring the ledger', async () => {
  await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '-5' });
  assert.equal(historyRetentionDays(process.env), DEFAULT_HISTORY_RETENTION_DAYS);
  await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: 'soon' });
  assert.equal(historyRetentionDays(process.env), DEFAULT_HISTORY_RETENTION_DAYS);
  // Same for the row cap, which has no "off" value at all: a typo must not
  // turn a bounded ledger into an unbounded one.
  await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '0' });
  assert.equal(historyMaxRows(process.env), DEFAULT_HISTORY_MAX_ROWS);
  await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '' });
  assert.equal(historyMaxRows(process.env), DEFAULT_HISTORY_MAX_ROWS);
});

test('the startup sweep prunes an account no append will ever reach', async () => {
  const { dir, ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '90' });
  // A named profile's ledger, which only that profile's own mutations would
  // touch. The profile exists because its TOKEN file exists — that is how
  // `historyFilePaths` enumerates accounts, so the fixture has to make one.
  await writeFile(join(ROOT, 'tokens.work.json'), '{}', { encoding: 'utf8', mode: 0o600 });
  assert.notEqual(join(dir, 'mutations.work.jsonl'), ledger, 'precondition: two accounts');
  await writeFile(join(dir, 'mutations.work.jsonl'), [line('dormant-ancient', 400), line('dormant-fresh', 2)].join(''), {
    encoding: 'utf8',
    mode: 0o600,
  });

  await pruneHistoryLedgers(process.env);

  const kept = (await readHistory({ file: join(dir, 'mutations.work.jsonl'), limit: 100 })).map((r) => String(r.who));
  assert.deepEqual(kept, ['dormant-fresh'], "a dormant account's ledger must still be expired");
});

// ------------------------------------------------------------ observability

test('the ledger stats report the exact row count, the cap and the oldest record', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '100' });
  await seed(ledger, [line('ancient', 40), line('recent', 3)]);

  const stats = await historyLedgerStats(process.env, DEFAULT_TOKEN_FILE);
  assert.equal(stats.rows, 2, 'the row count is exact, not a capped read');
  assert.equal(stats.max_rows, 100);
  assert.equal(stats.retention_days, DEFAULT_HISTORY_RETENTION_DAYS);
  assert.equal(stats.oldest_ts, new Date(PINNED_NOW - 40 * DAY_MS).toISOString());

  // An empty ledger reports no oldest record rather than a defaulted date.
  const empty = await sandbox({});
  const none = await historyLedgerStats(process.env, DEFAULT_TOKEN_FILE);
  assert.equal(none.rows, 0);
  assert.equal(none.oldest_ts, undefined, 'an empty ledger has no oldest record to report');
  assert.ok(empty.ledger.length > 0);
});

test('spotify_doctor reports the row count, the oldest record and how to purge', async () => {
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '100' });
  await seed(ledger, [line('ancient', 40), line('recent', 3)]);

  const { collectDoctorReport } = await import('../src/tools/doctortool.js');
  const { SpotifyClient } = await import('../src/client.js');
  const report = await collectDoctorReport(new SpotifyClient({} as never));
  const row = report.rows.find((r) => r.id === 'history');
  assert.ok(row, 'doctor must emit a history row');
  assert.match(row!.detail ?? '', /2\/100 row\(s\) retained/, `row count missing: ${row!.detail}`);
  assert.match(
    row!.detail ?? '',
    new RegExp(`oldest record ${new Date(PINNED_NOW - 40 * DAY_MS).toISOString().slice(0, 10)}`),
    `oldest record missing: ${row!.detail}`,
  );
  assert.match(row!.detail ?? '', /retention 90d/);
  assert.match(row!.detail ?? '', /history_purge=spotify-mcp logout/);
  assert.equal(row!.fields?.history_rows, 2);
  assert.equal(row!.fields?.history_max_rows, 100);
  assert.equal(row!.fields?.history_retention_days, 90);
  assert.equal(row!.fields?.history_oldest_ts, new Date(PINNED_NOW - 40 * DAY_MS).toISOString());
  assert.equal(row!.fields?.history_purge, 'spotify-mcp logout');
  assert.ok(ledger.length > 0);
});

// ------------------------------------------------------------------- logout

test('the purge list names every ledger file, including the rotated generation', async () => {
  await sandbox({});
  const paths = historyLedgerPaths(process.env);
  assert.ok(
    paths.some((p) => p.endsWith('mutations.jsonl')),
    'the live ledger must be purgeable',
  );
  assert.ok(
    paths.some((p) => p.endsWith('mutations.jsonl.1')),
    `the rotated generation must be purgeable, got ${paths.join(', ')}`,
  );
});

test('an undated head line does not shield the ancient records behind it', async () => {
  // The failure this pins. `oldest_ts` has two plausible spellings — the
  // oldest LINE, or the oldest line that CARRIES a parseable `ts` — and the
  // ledger's own header comment says the second, because an undated line is
  // not a date the report may borrow from the next record. Where the first
  // spelling was used, a ledger headed by an undated line cached
  // `oldest_ts: undefined`, and `ledgerNeedsPrune` reads an absent
  // `oldest_ts` as "nothing can be expired". The undated head therefore
  // disabled the whole age cap for as long as the cached shape was trusted,
  // while the very next honest measure of the same bytes named a date 400
  // days old and expired them.
  //
  // The window is WIDE for the seeding sweep and then TIGHTENED, because that
  // is what isolates the cache: the sweep has to be a genuine no-op (nothing
  // dropped) for it to write the shape the append later trusts, and it can
  // only be a no-op while the ancient records are still in window.
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_RETENTION_DAYS: '99999' });
  // Undated head, then two records far outside any 90-day window.
  await seed(ledger, ['{"who":"hand-written"}\n', line('ancient-1', 400), line('ancient-2', 500)]);

  // A no-op sweep seeds the cached shape exactly as a startup would.
  const noop = await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);
  assert.equal(noop.expired, 0, 'precondition: the wide window expires nothing');
  assert.equal(noop.rows_after, 3, 'precondition: the sweep kept every row');
  assert.equal(
    (await rows(ledger)).length,
    3,
    'precondition: the seeded shape is the one the append will trust',
  );

  // The operator tightens retention. The ancient records are now 400 and 500
  // days past a 90-day window, and an append is the moment the ledger is
  // re-checked.
  process.env.SPOTIFY_MCP_HISTORY_RETENTION_DAYS = '90';
  const before = await historyLedgerStats(process.env, DEFAULT_TOKEN_FILE);
  assert.ok(
    typeof before.oldest_ts === 'string' && Date.parse(before.oldest_ts) < PINNED_NOW - 365 * DAY_MS,
    `precondition: the ledger can date a record older than the window, got ${String(before.oldest_ts)}`,
  );

  await appendHistory({ method: 'PUT', path: '/playlists/{id}/items', who: 'newest' }, DEFAULT_TOKEN_FILE);

  const kept = await whoList(ledger);
  assert.equal(
    kept.includes('ancient-1'),
    false,
    `an undated head line must not exempt the ancient records behind it; kept ${kept.join(', ')}`,
  );
  assert.equal(kept.includes('ancient-2'), false, 'every out-of-window record must be expired');
  assert.deepEqual(kept, ['hand-written', 'newest'], 'the undated line and the new record both survive');
});

test('a prune drops nothing the bounds did not ask it to', async () => {
  // The row cap must not become a second, tighter byte cap. Here every record
  // is inside the window and the ledger is nowhere near the row cap, so a
  // prune that shed anything here would be shedding on its own initiative.
  // A prune that sheds nothing must also not WRITE: the startup sweep runs on
  // every start, and rewriting two files it had no reason to change would put
  // an fsync on the path to a `tools/list`.
  const { ledger } = await sandbox({ SPOTIFY_MCP_HISTORY_MAX_ROWS: '5000' });
  const body = Array.from({ length: 20 }, (_, i) => line(`t-${i}`, 1));
  // The layout rotation actually produces: the ARCHIVE holds the older half.
  await seed(ledger, body.slice(0, 10), true);
  await seed(ledger, body.slice(10));
  const liveBefore = await readFile(ledger, 'utf8');
  const archiveBefore = await readFile(`${ledger}.1`, 'utf8');

  const result = await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);
  assert.equal(result.expired, 0);
  assert.equal(result.over_cap, 0);
  assert.equal(result.rows_after, 20, 'nothing is in the window or over the cap, so nothing is dropped');
  assert.deepEqual(
    (await rows(ledger)).map((r) => String(r.who)),
    body.map(() => '').map((_, i) => `t-${i}`),
    'every record must survive, in order',
  );
  assert.equal(await readFile(ledger, 'utf8'), liveBefore, 'a no-op prune must not rewrite the live ledger');
  assert.equal(
    await readFile(`${ledger}.1`, 'utf8'),
    archiveBefore,
    'a no-op prune must not rewrite the rotated generation either',
  );
});

test('a prune does not create a ledger for an account that has never mutated anything', async () => {
  // The startup sweep enumerates every account, including ones whose ledger
  // does not exist yet. Creating an empty file for each would leave litter
  // under the history directory for a state the user never entered.
  const { ledger } = await sandbox({});
  await assert.rejects(() => readFile(ledger, 'utf8'), /ENOENT/);
  const result = await pruneHistoryLedger(process.env, DEFAULT_TOKEN_FILE, PINNED_NOW);
  assert.deepEqual(result, { rows_before: 0, rows_after: 0, expired: 0, over_cap: 0 });
  await assert.rejects(() => readFile(ledger, 'utf8'), /ENOENT/);
});
