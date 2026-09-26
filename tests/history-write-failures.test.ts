/**
 * #591 — the mutation ledger must not lose writes invisibly.
 *
 * Three properties are covered, each observed through the real code path
 * (real McpServer + installTruncationBoundary + real SpotifyClient + a
 * real `play` tool call over the in-memory transport):
 *
 *   1. `who` names the tool that issued the mutation, not the 'agent'
 *      default that every record used to carry.
 *   2. A lost append warns exactly once per process, while the mutation
 *      that triggered it still succeeds.
 *   3. spotify_doctor reports the resolved path plus a write-failure
 *      counter, and a lost append makes the row red.
 *
 * Two failure fixtures with deliberately different errnos, so nothing here
 * passes on a hardcoded EACCES:
 *   - unwritable PARENT dir whose child does not exist  -> mkdir EACCES
 *   - a regular file standing where a directory belongs -> mkdir ENOTDIR
 *
 * NB: chmod 0500 on the history dir itself is NOT a usable fixture — the
 * writer re-asserts 0700 on every append, so it repairs the mode and the
 * write succeeds. The failure has to land before that chmod, at mkdir.
 *
 * Run: node --import tsx --test tests/history-write-failures.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { HistoryRecord } from '../src/history.ts';

// Static imports of src/ cannot work here: the token-file path binds at
// module-load time in src/auth.ts, so the env below must be set first.
const root = await mkdtemp(path.join(tmpdir(), 'spotify-mcp-history-591-'));
const TOKEN_FILE = path.join(root, 'tokens.json');
const HISTORY_DIR = path.join(root, 'history');
process.env.SPOTIFY_MCP_TOKEN_FILE = TOKEN_FILE;
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_MCP_HISTORY = '1';
process.env.SPOTIFY_MCP_HISTORY_DIR = HISTORY_DIR;

await writeFile(
  TOKEN_FILE,
  JSON.stringify({
    access_token: 'tok-initial',
    refresh_token: 'ref-initial',
    expires_at: Date.now() + 3_600_000,
  }),
  'utf8',
);

const { SpotifyClient } = await import('../src/client.ts');
const { initConfig } = await import('../src/config.ts');
const { installTruncationBoundary } = await import('../src/shaping.js');
const { readHistory, historyWriteStatus, __resetHistoryWriteState } = await import('../src/history.ts');
const { registerPlaybackTools } = await import('../src/tools/playback.ts');
const { collectDoctorReport } = await import('../src/tools/doctortool.ts');

initConfig();

const LEDGER = path.join(HISTORY_DIR, 'mutations.jsonl');
const realFetch = globalThis.fetch;
let warnings: string[] = [];
let stderrCaptured = false;

// The client must never reach the real API from a test: a 401 here would be
// indistinguishable from a genuine transport failure.
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const body = url.startsWith('https://accounts.spotify.com/')
    ? { access_token: 'tok-refreshed', refresh_token: 'ref-initial', expires_in: 3600 }
    : {};
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

/** Capture console.error; restored verbatim so failures still print. */
function captureStderr(): void {
  if (stderrCaptured) return;
  stderrCaptured = true;
  console.error = (...args: unknown[]): void => {
    warnings.push(args.map((a) => String(a)).join(' '));
  };
}

function releaseStderr(): void {
  if (!stderrCaptured) return;
  stderrCaptured = false;
  console.error = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((a) => String(a)).join(' ')}\n`);
  };
}

function nextTick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/**
 * Drain the event loop until `check()` holds. The ledger append is
 * deliberately fire-and-forget, so a test must wait for the write to have
 * actually happened rather than assume it already did.
 */
async function waitFor(check: () => boolean, what: string): Promise<void> {
  let guard = 0;
  while (!check()) {
    if (guard++ > 5_000) assert.fail(`timed out waiting for ${what}`);
    await nextTick();
  }
}

/** Read the ledger, waiting for the fire-and-forget append to land. */
async function ledgerRecords(): Promise<HistoryRecord[]> {
  let records = await readHistory();
  let guard = 0;
  while (records.length === 0 && guard++ < 5_000) {
    await nextTick();
    records = await readHistory();
  }
  return records;
}

/** Drive the real `play` tool over the real boundary, client and transport. */
async function callPlay(): Promise<{ isError?: boolean; text: string }> {
  const server = new McpServer({ name: 'history-591-server', version: '0.0.0' });
  installTruncationBoundary(server);
  registerPlaybackTools(server, new SpotifyClient());
  const mcp = new Client({ name: 'history-591-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  try {
    const result = await mcp.callTool({ name: 'play', arguments: {} });
    const text =
      (result.content as Array<{ type: string; text: string }> | undefined)
        ?.map((block) => block.text)
        .join('\n') ?? '';
    return { isError: result.isError as boolean | undefined, text };
  } finally {
    await mcp.close();
    await server.close();
  }
}

function historyWarnLines(): string[] {
  return warnings.filter((line) => line.includes('history write failed'));
}

/**
 * An unwritable parent whose `history` child does not exist yet, so the very
 * first mkdir — before the writer's chmod can repair anything — hits EACCES.
 */
async function unwritableHistoryDir(): Promise<string> {
  const parent = path.join(root, 'ro');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o500);
  const dir = path.join(parent, 'history');
  process.env.SPOTIFY_MCP_HISTORY_DIR = dir;
  return dir;
}

describe('#591 mutation-ledger write failures', () => {
  beforeEach(() => {
    warnings = [];
    captureStderr();
    __resetHistoryWriteState();
    process.env.SPOTIFY_MCP_HISTORY = '1';
    process.env.SPOTIFY_MCP_HISTORY_DIR = HISTORY_DIR;
  });

  afterEach(async () => {
    releaseStderr();
    // Restore the fixtures' modes so cleanup can unlink their children.
    for (const dir of [path.join(root, 'ro'), HISTORY_DIR]) {
      await chmod(dir, 0o700).catch(() => undefined);
    }
    await rm(HISTORY_DIR, { recursive: true, force: true });
    __resetHistoryWriteState();
  });

  it('records the originating tool in who for a tool-driven mutation', async () => {
    await mkdir(HISTORY_DIR, { recursive: true, mode: 0o700 });
    const result = await callPlay();
    assert.equal(result.isError, undefined, 'the mutation itself must succeed');

    const records = await ledgerRecords();
    assert.equal(records.length, 1, 'one mutation, one ledger line');
    assert.equal(records[0]?.path, '/me/player/play');
    assert.equal(
      records[0]?.who,
      'play',
      'who must name the tool that issued the mutation, not the "agent" default',
    );
  });

  it('keeps the agent default for a mutation issued outside any tool context', async () => {
    await mkdir(HISTORY_DIR, { recursive: true, mode: 0o700 });
    await new SpotifyClient().put('/me/player/pause');

    const records = await ledgerRecords();
    assert.equal(records[0]?.path, '/me/player/pause');
    assert.equal(records[0]?.who, 'agent', 'no ambient tool ⇒ the historical default stands');
  });

  it('warns exactly once per process for a lost append and never fails the mutation', async () => {
    await unwritableHistoryDir();

    const first = await callPlay();
    const second = await callPlay();
    assert.equal(first.isError, undefined, 'a history failure must not fail the mutation');
    assert.equal(second.isError, undefined, '…on the second mutation either');
    assert.ok(first.text.includes('Playback started'), `unexpected result: ${first.text}`);

    await waitFor(() => historyWriteStatus().failures >= 2, 'both lost appends to be counted');

    const lines = historyWarnLines();
    assert.equal(lines.length, 1, `exactly one warning per process, got: ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /EACCES/);
    assert.match(lines[0]!, /history[/\\]mutations\.jsonl/);
    assert.match(lines[0]!, /audit trail incomplete/);

    const status = historyWriteStatus();
    assert.equal(status.failures, 2, 'every lost append is counted, not just the first');
    assert.equal(status.enabled, true);
    assert.match(status.last_failure ?? '', /^EACCES on /);
  });

  it('counts a distinct errno too, so the counter is not EACCES-specific', async () => {
    // ENOTDIR: a regular file stands where the history directory must be.
    const blocker = path.join(root, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');
    process.env.SPOTIFY_MCP_HISTORY_DIR = path.join(blocker, 'history');

    const result = await callPlay();
    assert.equal(result.isError, undefined);
    await waitFor(() => historyWriteStatus().failures >= 1, 'the lost append to be counted');

    const status = historyWriteStatus();
    assert.equal(status.failures, 1);
    assert.match(status.last_failure ?? '', /^ENOTDIR on /);
    assert.equal(historyWarnLines().length, 1);
    assert.match(historyWarnLines()[0] ?? '', /ENOTDIR/);
  });

  it('reports the resolved path and a pass row while the ledger is healthy', async () => {
    await mkdir(HISTORY_DIR, { recursive: true, mode: 0o700 });
    await callPlay();
    assert.equal((await ledgerRecords()).length, 1, 'the healthy append reached disk');

    const report = await collectDoctorReport(new SpotifyClient());
    const row = report.rows.find((r) => r.id === 'history');
    assert.ok(row, 'doctor must report the history path');
    assert.equal(row.status, 'pass');
    assert.ok(row.summary.includes(LEDGER), `summary must name the ledger path: ${row.summary}`);
    assert.ok(row.summary.includes('0 write failures'), row.summary);
    // No server is passed, so the `surface` row is independently fail; the
    // claim under test is narrower — the healthy ledger is not a fail cause.
    const failing = report.rows.filter((r) => r.status === 'fail').map((r) => r.id);
    assert.ok(!failing.includes('history'), `a healthy ledger must not fail the diagnostic: ${failing}`);
  });

  it('turns the doctor history row red and the report not-ok once a write is lost', async () => {
    const unwritable = await unwritableHistoryDir();
    await callPlay();
    await waitFor(() => historyWriteStatus().failures >= 1, 'the lost append to be counted');

    const report = await collectDoctorReport(new SpotifyClient());
    const row = report.rows.find((r) => r.id === 'history');
    assert.ok(row, 'doctor must report the history path');
    assert.equal(row.status, 'fail', 'a lost append means the trail cannot be trusted');
    assert.ok(row.summary.includes(path.join('history', 'mutations.jsonl')), row.summary);
    assert.ok(row.summary.includes('failed 1 time(s)'), row.summary);
    assert.match(row.detail ?? '', /last_failure=EACCES on /);
    assert.equal(report.ok, false, 'a non-ok doctor row is the acceptance criterion');
    assert.ok(
      row.summary.includes(unwritable),
      `the row must name the path it could not write: ${row.summary}`,
    );
  });

  it('says so plainly when history is switched off', async () => {
    process.env.SPOTIFY_MCP_HISTORY = '0';
    const report = await collectDoctorReport(new SpotifyClient());
    const row = report.rows.find((r) => r.id === 'history');
    assert.equal(row?.status, 'info', 'an unrequested trail is not a failure');
    assert.ok(row?.summary.includes('disabled'), row?.summary);
  });
});

after(async () => {
  globalThis.fetch = realFetch;
  releaseStderr();
  for (const dir of [path.join(root, 'ro'), HISTORY_DIR]) {
    await chmod(dir, 0o700).catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});
