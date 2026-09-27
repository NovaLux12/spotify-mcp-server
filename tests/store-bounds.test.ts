/**
 * #905 — the two stores that grew without bound.
 *
 *   * the taste feedback store (src/tools/statsfm_taste.ts): a module-global
 *     array that was copied in full on every read and vanished at restart;
 *   * the mutation history ledger (src/history.ts), which already rotated but
 *     reported neither its size nor its record count, so growth was invisible.
 *
 * Every test here writes to a temp directory. The default store is
 * ~/.spotify-mcp/taste-feedback.json, which is the USER's file: a rotation test
 * that ran against the default path would evict real verdicts, and the cleanup
 * would then delete real records. `assertStoreIsolated` below is the tripwire
 * for that mistake.
 */
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import type { z } from 'zod';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerStatsfmTasteTools, __clearFeedbackEntries } from '../src/tools/statsfm_taste.js';
import { historyLedgerStats, historyMaxBytes } from '../src/history.js';

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const ROOT = await mkdtemp(join(tmpdir(), 'spotify-mcp-905-'));
const STORE = join(ROOT, 'taste-feedback.json');

/** Every test in this file must have redirected the store off the real home. */
function assertStoreIsolated(): void {
  const resolved = process.env.SPOTIFY_MCP_TASTE_FEEDBACK_FILE;
  assert.ok(resolved, 'SPOTIFY_MCP_TASTE_FEEDBACK_FILE must be set for every test in this file');
  assert.ok(
    resolved.startsWith(tmpdir()) || resolved.startsWith(ROOT),
    `store path ${resolved} is not inside a temp dir — this test would touch the user's real store`,
  );
}

function harness() {
  const registered: Array<{ name: string; handler: unknown; params: Record<string, z.ZodTypeAny> }> = [];
  const server = {
    tool(name: string, _desc: string, params: Record<string, z.ZodTypeAny>, handler: unknown) {
      registered.push({ name, handler, params });
    },
  };
  registerStatsfmTasteTools(server as never, {} as never);
  const find = (name: string) => {
    const hit = registered.find((t) => t.name === name);
    assert.ok(hit, `missing tool ${name}`);
    return hit;
  };
  // The canonical name, not the `record_feedback` alias retired in #908: the
  // alias is no longer registered, so looking it up here would fail the whole
  // file on a name that was never a separate tool.
  const hit = find('statsfm_record_feedback');
  return {
    record: hit.handler as (a: Record<string, unknown>) => Promise<ToolContent>,
    params: hit.params,
  };
}

const invoke = (fn: (a: Record<string, unknown>) => Promise<ToolContent>, args: Record<string, unknown> = {}) =>
  fn(args);

/** The subject `record()` writes for verdict `n`, so assertions can name it. */
function subjectFor(n: number, subjectLength = 8): string {
  return `t${String(n).padStart(5, '0')}${'x'.repeat(Math.max(0, subjectLength - 6))}`;
}

/** Record one verdict. `subject` is unique so "which survived" is answerable. */
async function record(
  fn: (a: Record<string, unknown>) => Promise<ToolContent>,
  n: number,
  subjectLength = 8,
): Promise<void> {
  const res = await invoke(fn, {
    subject_type: 'track',
    subject: subjectFor(n, subjectLength),
    rating: 'like',
  });
  assert.ok(!res.isError, `record #${n} failed: ${res.content.map((c) => c.text).join(' ')}`);
}

async function readStore(): Promise<{
  entries: Array<{ id: number; subject: string }>;
  recorded: number;
  evicted: number;
  seq: number;
}> {
  return JSON.parse(await readFile(STORE, 'utf8'));
}

/**
 * Caps are read from process.env at call time, so a test that lowers one leaks
 * it into the next unless it is cleared here. A leaked byte cap silently caps an
 * unrelated test's store and the failure reads as a bug in the store.
 */
const CAP_VARS = [
  'SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES',
  'SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES',
] as const;

test.beforeEach(async () => {
  for (const v of CAP_VARS) delete process.env[v];
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_FILE = STORE;
  // Preserved .corrupt[N] copies are named off the store, so a leftover from
  // the previous test would claim the next test's first corruption and shift
  // every assertion that names which copy is whose.
  for (const f of await readdir(ROOT)) {
    if (f.startsWith('taste-feedback.json')) await rm(join(ROOT, f), { force: true, recursive: true });
  }
  __clearFeedbackEntries();
});

test.after(() => {
  delete process.env.SPOTIFY_MCP_TASTE_FEEDBACK_FILE;
  for (const v of CAP_VARS) delete process.env[v];
  rmSyncQuiet(ROOT);
});

function rmSyncQuiet(dir: string): void {
  // after() is sync; the suite has already awaited the store teardown.
  void rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- count cap

test('the store evicts oldest-first at the record cap and says how many it dropped', async () => {
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES = '10';
  const { record: rec } = harness();
  for (let i = 1; i <= 25; i++) await record(rec, i);

  const store = await readStore();
  assert.equal(store.entries.length, 10, 'store must hold exactly the cap');
  // What survives must be the NEWEST ten, not an arbitrary ten.
  assert.deepEqual(
    store.entries.map((e) => e.id),
    [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
  );
  assert.equal(store.entries[0]!.subject, subjectFor(16), 'oldest surviving subject must be #16');
  assert.equal(store.recorded, 25, 'lifetime recorded count must survive eviction');
  assert.equal(store.evicted, 15, '15 of 25 verdicts were dropped by the cap');
  assert.equal(store.seq, 25, 'seq must not rewind, or an id is reused');
});

test('1,000 verdicts leave a store of at most 500, the newest, with the drop counted', async () => {
  // The issue's acceptance criterion, driven through the real tool at defaults.
  const { record: rec } = harness();
  for (let i = 1; i <= 1000; i++) await record(rec, i);

  const store = await readStore();
  assert.ok(store.entries.length <= 500, `store held ${store.entries.length}, expected <= 500`);
  assert.equal(store.entries.length, 500, 'at the default cap the store is exactly full');
  assert.equal(store.recorded, 1000);
  assert.equal(store.evicted, 500);
  assert.equal(store.entries.at(-1)!.id, 1000, 'newest verdict is last');
  assert.equal(store.entries[0]!.id, 501, 'oldest surviving verdict is #501');
});

// ----------------------------------------------------------------- byte cap

test('a raised count cap cannot unbind the store: the byte cap still evicts', async () => {
  // A count cap alone is not a size bound. Raise it far past what the file may
  // hold and the byte cap must be the one that bites.
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES = '100000';
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_BYTES = '4096';
  const { record: rec } = harness();
  // Long subjects, so the count cap is nowhere near binding.
  for (let i = 1; i <= 200; i++) await record(rec, i, 200);

  const bytes = (await stat(STORE)).size;
  assert.ok(bytes <= 4096, `store is ${bytes} B, over the 4096 B cap`);
  const store = await readStore();
  assert.ok(store.entries.length > 0, 'the byte cap must not evict the store to nothing');
  assert.ok(store.evicted > 0, 'byte-cap evictions must be counted, not silent');
  assert.equal(store.entries.at(-1)!.id, 200, 'the newest verdict always survives');
  assertStoreIsolated();
});

test('a single record cannot be arbitrarily large — subject is capped at the tool boundary', async () => {
  const { record: rec, params } = harness();
  // The handler runs the store's own clamps, but the value arrives through MCP
  // schema validation first. Assert on the declared schema, which is what a
  // real host enforces, rather than on a handler that never saw the rejection.
  const parsed = params.subject!.safeParse('x'.repeat(200));
  assert.equal(parsed.success, true, '200 chars is the documented maximum and must be accepted');
  const tooLong = params.subject!.safeParse('x'.repeat(201));
  assert.equal(tooLong.success, false, 'the schema must reject a subject past the record bound');
  // And the store clamps regardless, so a value that arrived another way cannot
  // become an unbounded record on disk.
  const res = await invoke(rec, { subject_type: 'track', subject: 'x'.repeat(5000), rating: 'love' });
  assert.ok(!res.isError);
  const store = await readStore();
  assert.equal(store.entries[0]!.subject.length, 200);
  assertStoreIsolated();
});

// -------------------------------------------------------------- bounded read

test('action=list returns a bounded page plus the total, never the whole store', async () => {
  const { record: rec } = harness();
  for (let i = 1; i <= 30; i++) await record(rec, i);

  const listed = await invoke(rec, { action: 'list', limit: 5 });
  const sc = listed.structuredContent as {
    entries: unknown[];
    returned: number;
    retained: number;
    truncated: boolean;
    recorded: number;
    evicted: number;
  };
  assert.equal(sc.entries.length, 5, 'the page must honour limit');
  assert.equal(sc.returned, 5);
  assert.equal(sc.retained, 30, 'the total must report what the store retains');
  assert.equal(sc.truncated, true);
  assert.equal(sc.recorded, 30);
  assert.equal(sc.evicted, 0);
  // The newest, in chronological order within the page.
  assert.equal((sc.entries[0] as { id: number }).id, 26);
  assert.equal((sc.entries[4] as { id: number }).id, 30);
});

test('a list page is bounded by default even with a full store', async () => {
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES = '25';
  const { record: rec } = harness();
  for (let i = 1; i <= 30; i++) await record(rec, i);
  const listed = await invoke(rec, { action: 'list' });
  const sc = listed.structuredContent as { entries: unknown[]; retained: number };
  assert.equal(sc.entries.length, 20, 'default page is 20, not the whole store');
  assert.equal(sc.retained, 25);
  assert.ok(
    listed.content.map((c) => c.text).join('\n').includes('5 evicted by the cap'),
    `the prose must say the cap dropped verdicts: ${listed.content.map((c) => c.text).join(' ')}`,
  );
});

// -------------------------------------------------------- corrupt on load

test('a corrupt store is preserved and surfaced, never silently replaced with an empty one', async () => {
  const { record: rec } = harness();
  await record(rec, 1);
  const GOOD = await readFile(STORE, 'utf8');

  // Truncate mid-document: what a crash between write and rename would leave if
  // the write were not atomic.
  await writeFile(STORE, GOOD.slice(0, Math.floor(GOOD.length / 2)), 'utf8');
  const CORRUPT = await readFile(STORE, 'utf8');

  const listed = await invoke(rec, { action: 'list' });
  assert.equal(listed.isError, true, 'a truncated store must not read as an empty store');
  const sc = listed.structuredContent as { reason: string; error: string };
  assert.equal(sc.reason, 'store_unreadable');
  assert.match(sc.error, /not valid JSON/);
  // src/sidecar.ts policy: the exact bytes are kept, and the original is left.
  assert.ok(existsSync(`${STORE}.corrupt`), 'bytes must be preserved at <file>.corrupt');
  assert.equal(await readFile(`${STORE}.corrupt`, 'utf8'), CORRUPT, 'preserved copy must be byte-identical');
  assert.equal(await readFile(STORE, 'utf8'), CORRUPT, 'the original must be left in place, not reset');
  assert.equal((await stat(`${STORE}.corrupt`)).mode & 0o777, 0o600, 'preserved copy is owner-only');
  assertStoreIsolated();
});

test('a record into a corrupt store is refused, and the corrupt bytes survive the refusal', async () => {
  const { record: rec } = harness();
  const CORRUPT = '{"entries": [ {"id": 1, ';
  await writeFile(STORE, CORRUPT, 'utf8');

  const res = await invoke(rec, { subject_type: 'artist', subject: 'Core Band', rating: 'love' });
  assert.equal(res.isError, true);
  const sc = res.structuredContent as { reason: string; error: string };
  assert.equal(sc.reason, 'store_unreadable');
  assert.match(sc.error, /\.corrupt/, 'the error must name the preserved copy');
  assert.equal(await readFile(STORE, 'utf8'), CORRUPT, 'a refused write must not overwrite the store');
  assert.equal(await readFile(`${STORE}.corrupt`, 'utf8'), CORRUPT);
  assertStoreIsolated();
});

test('a second corruption does not clobber the first preserved copy', async () => {
  const { record: rec } = harness();
  await writeFile(STORE, '{ first', 'utf8');
  await invoke(rec, { action: 'list' });
  await writeFile(STORE, '{ second', 'utf8');
  const second = await invoke(rec, { action: 'list' });
  assert.equal(second.isError, true);
  assert.equal(await readFile(`${STORE}.corrupt`, 'utf8'), '{ first', 'the first copy is still intact');
  assert.ok(existsSync(`${STORE}.corrupt.1`), 'the second copy gets its own name');
  assert.equal(await readFile(`${STORE}.corrupt.1`, 'utf8'), '{ second');
  assertStoreIsolated();
});

test('a hand-edited store with an oversized subject is clamped, not rejected', async () => {
  const { record: rec } = harness();
  await writeFile(
    STORE,
    JSON.stringify({
      entries: [
        {
          id: 1,
          at: '2026-09-01T00:00:00.000Z',
          subject_type: 'artist',
          subject: 'y'.repeat(5000),
          rating: 'love',
          note: null,
        },
      ],
      recorded: 1,
      evicted: 0,
      seq: 1,
    }),
    'utf8',
  );
  const listed = await invoke(rec, { action: 'list' });
  assert.notEqual(listed.isError, true, 'a recoverable store must still load');
  const subject = (listed.structuredContent as { entries: Array<{ subject: string }> }).entries[0]!.subject;
  assert.equal(subject.length, 200, 'the oversized field is clamped to the record bound');
});

// ---------------------------------------------------------------- atomicity

test('a reader never observes a half-written store, which is what rename(2) buys', async () => {
  // The distinction this test exists to pin down is temp+rename versus
  // truncate-and-append. The store is ONE JSON document, so a rewrite that
  // truncates the target first would expose an empty or partial document to
  // any concurrent reader; a rename publish does not. A non-atomic rewrite
  // fails this test; the current implementation passes it.
  const { record: rec } = harness();
  await record(rec, 1);
  const baseline = await readStore();
  assert.equal(baseline.entries.length, 1);

  let reads = 0;
  let stop = false;
  // Read the store as fast as it is being rewritten.
  const reader = (async () => {
    while (!stop) {
      const raw = await readFile(STORE, 'utf8').catch(() => null);
      if (raw !== null) {
        reads++;
        // Every observation must be a complete, valid document — never a
        // truncated prefix, never an empty file mid-rewrite.
        const parsed = JSON.parse(raw) as { entries: unknown[] };
        assert.ok(Array.isArray(parsed.entries), 'reader saw a document with no entries array');
      }
      await new Promise((r) => setImmediate(r));
    }
  })();

  for (let i = 2; i <= 40; i++) await record(rec, i);
  stop = true;
  await reader;

  assert.ok(reads > 5, `the reader only got ${reads} reads — the race was not exercised`);
  const final = await readStore();
  assert.equal(final.entries.length, 40, 'no record was lost to a concurrent read');
  assertStoreIsolated();
});

test('a write that cannot land is reported as a failure, never as a recorded verdict', async () => {
  // Point the store at a path whose parent is a regular file, so mkdir cannot
  // create it. A verdict that reports success while nothing reached disk is the
  // #764 watchlist failure.
  const blocker = join(ROOT, 'not-a-dir');
  await writeFile(blocker, 'x', 'utf8');
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_FILE = join(blocker, 'taste-feedback.json');
  try {
    const { record: rec } = harness();
    const res = await invoke(rec, { subject_type: 'track', subject: 't99999', rating: 'love' });
    assert.equal(res.isError, true, 'an unwritable store must not read as a successful record');
    const sc = res.structuredContent as { reason: string; persisted: boolean };
    assert.equal(sc.reason, 'store_unwritable');
    assert.equal(sc.persisted, false);
  } finally {
    process.env.SPOTIFY_MCP_TASTE_FEEDBACK_FILE = STORE;
  }
  assertStoreIsolated();
});

test('a successful write leaves no temp file behind, and a stale temp is ignored on read', async () => {
  const { record: rec } = harness();
  // A temp stranded by a crash that predates this change.
  const STALE = `${STORE}.9999.deadbeef.tmp`;
  await writeFile(STALE, 'not json at all', 'utf8');
  await record(rec, 1);

  const listed = await invoke(rec, { action: 'list' });
  assert.notEqual(listed.isError, true, 'a stale temp must not make the store unreadable');
  const left = (await readdir(ROOT)).filter((f) => f.endsWith('.tmp') && join(ROOT, f) !== STALE);
  assert.deepEqual(left, [], `this write left temp files behind: ${left.join(', ')}`);
});

test('concurrent records do not lose verdicts to a read-modify-write race', async () => {
  process.env.SPOTIFY_MCP_TASTE_FEEDBACK_MAX_ENTRIES = '500';
  const { record: rec } = harness();
  // recordFeedbackEntry awaits between its read and its write, so without the
  // serialisation queue the last writer would discard the others' records.
  await Promise.all(Array.from({ length: 12 }, (_, i) => record(rec, i + 1)));
  const store = await readStore();
  assert.equal(store.entries.length, 12, 'every concurrent verdict must survive');
  assert.equal(new Set(store.entries.map((e) => e.id)).size, 12, 'no duplicate ids');
});

// ------------------------------------------------------------- persistence

test('the store survives a restart, which is the reason it is a file', async () => {
  const { record: rec } = harness();
  await record(rec, 7);
  // A new process starts with a fresh module graph and an empty write queue.
  __clearFeedbackEntries();
  const { record: rec2 } = harness();
  const listed = await invoke(rec2, { action: 'list' });
  const sc = listed.structuredContent as { entries: Array<{ id: number; subject: string }> };
  assert.equal(sc.entries.length, 1);
  assert.equal(sc.entries[0]!.subject, subjectFor(7));
});

// ------------------------------------------------------ history observability

test('the history ledger reports its size and record count, and both cap truthfully', async () => {
  const dir = join(ROOT, 'history');
  process.env.SPOTIFY_MCP_HISTORY_DIR = dir;
  process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES = '400';
  process.env.SPOTIFY_MCP_HISTORY = '1';
  try {
    const { appendHistory, readHistory } = await import('../src/history.js');
    for (let i = 0; i < 60; i++) {
      await appendHistory({ method: 'POST', path: `/playlists/p${i}/items` }, DEFAULT_TOKEN_FILE);
    }
    const stats = await historyLedgerStats(process.env, DEFAULT_TOKEN_FILE);
    const max = historyMaxBytes();
    assert.equal(stats.cap_bytes, max * 2, 'the cap is live + one rotated generation');
    assert.ok(stats.bytes > 0, 'the live file must be reported');
    assert.ok(
      stats.bytes + stats.archive_bytes <= max * 2,
      `ledger is ${stats.bytes + stats.archive_bytes} B, over the ${max * 2} B cap`,
    );
    assert.ok(stats.records > 0, 'the record count must be reported, not left blank');
    // Every reported record must be a real record, not a counted line.
    const readable = await readHistory({ file: join(dir, 'mutations.jsonl'), limit: stats.records });
    assert.equal(readable.length, stats.records);
    assert.equal(stats.records_capped, stats.records >= 500);
  } finally {
    delete process.env.SPOTIFY_MCP_HISTORY_DIR;
    delete process.env.SPOTIFY_MCP_HISTORY_MAX_BYTES;
    delete process.env.SPOTIFY_MCP_HISTORY;
  }
});

test('doctor reports the history ledger path and size', async () => {
  const dir = join(ROOT, 'doctor-history');
  process.env.SPOTIFY_MCP_HISTORY_DIR = dir;
  process.env.SPOTIFY_MCP_HISTORY = '1';
  try {
    const { appendHistory } = await import('../src/history.js');
    for (let i = 0; i < 5; i++) await appendHistory({ method: 'PUT', path: `/me/tracks?ids=x` }, DEFAULT_TOKEN_FILE);
    const { collectDoctorReport } = await import('../src/tools/doctortool.js');
    const { SpotifyClient } = await import('../src/client.js');
    const report = await collectDoctorReport(new SpotifyClient({} as never));
    const row = report.rows.find((r) => r.id === 'history');
    assert.ok(row, 'doctor must emit a history row');
    assert.match(row!.summary, /mutation history enabled/);
    assert.ok(row!.detail && row!.detail.includes('B live'), `size must be reported: ${row!.detail}`);
    assert.ok(row!.detail!.includes('record(s)'), 'the record count must be reported');
  } finally {
    delete process.env.SPOTIFY_MCP_HISTORY_DIR;
    delete process.env.SPOTIFY_MCP_HISTORY;
  }
});

test('doctor reports the taste feedback store, and a corrupt one is a fail row', async () => {
  const { collectDoctorReport } = await import('../src/tools/doctortool.js');
  const { SpotifyClient } = await import('../src/client.js');
  const report = await collectDoctorReport(new SpotifyClient({} as never));
  const row = report.rows.find((r) => r.id === 'taste_feedback');
  assert.ok(row, 'doctor must emit a taste_feedback row');
  assert.equal(row!.status, 'pass');
  assert.match(row!.summary, /retained/);

  await writeFile(STORE, '{ broken', 'utf8');
  const broken = await collectDoctorReport(new SpotifyClient({} as never));
  const badRow = broken.rows.find((r) => r.id === 'taste_feedback');
  assert.equal(badRow!.status, 'fail', 'an unreadable store is a fail row, not an empty one');
  assert.match(badRow!.detail!, /\.corrupt/);
  assert.equal(broken.ok, false, 'a fail row must turn the report red');
  assertStoreIsolated();
});
