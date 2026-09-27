/**
 * #839 — a corrupt search-history sidecar is preserved, never overwritten, and
 * never reported as an empty history.
 *
 * The pre-fix loader answered every read failure with `[]`, which is a real
 * answer ("no history yet") for a file that does not exist. The next search
 * appended one entry to that empty list and wrote it back over the file, so a
 * truncated sidecar — a crash mid-write, a full disk, a hand-edited typo —
 * cost the user every earlier search, silently, with nothing left on disk.
 *
 * Every test here asserts on the BYTES on disk, not on a flag: an internal
 * "did we preserve?" boolean would keep reporting true after the file itself
 * had been rewritten, which is the failure this issue is about.
 */
import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  __resetSearchHistoryEpisode,
  appendSearchHistory,
  loadSearchHistory,
  readSearchHistory,
  recordSearch,
  registerSearchHistoryTools,
} from '../src/tools/searchhistory.js';
import { SidecarUnreadableError } from '../src/sidecar.js';
import type { SpotifyClient } from '../src/client.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
};
type Registered = {
  name: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: unknown) => Promise<ToolResult>;
};

let dir: string;
let historyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sh-corrupt-'));
  historyFile = join(dir, 'search-history.json');
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  __resetSearchHistoryEpisode();
});
afterEach(async () => {
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE;
  delete process.env.SPOTIFY_MCP_SEARCH_HISTORY;
  __resetSearchHistoryEpisode();
  await rm(dir, { recursive: true, force: true });
});

/** Three months of real searches — the data a silent reset destroys. */
const REAL_HISTORY = [
  { id: 'sh_1', query: 'bjork', types: ['track'], timestamp: '2026-09-20T10:00:00.000Z', top_result_ids: ['spotify:track:a'] },
  { id: 'sh_2', query: 'aphex twin', types: ['track'], timestamp: '2026-09-21T10:00:00.000Z', top_result_ids: ['spotify:track:b'] },
  { id: 'sh_3', query: 'portishead', types: ['album'], timestamp: '2026-09-22T10:00:00.000Z', top_result_ids: ['spotify:album:c'] },
];

/** What a crash mid-write leaves behind: the first entry, cut in half. */
const TRUNCATED = JSON.stringify(REAL_HISTORY, null, 2).slice(0, 120);

function corruptTheFile(bytes = TRUNCATED): Promise<void> {
  return writeFile(historyFile, bytes, 'utf8');
}

function harness() {
  const registered: Registered[] = [];
  const client = { async get() { return { tracks: { items: [], total: 0 } }; } } as unknown as SpotifyClient;
  const server = {
    tool(name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: (args: unknown) => Promise<ToolResult>) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  registerSearchHistoryTools(server, client);
  return async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    const tool = registered.find((r) => r.name === name);
    assert.ok(tool, `expected ${name} to be registered`);
    return tool.handler(z.object(tool.schema).parse(args));
  };
}

const newEntry = {
  id: 'sh_new',
  query: ' Boards of Canada',
  types: ['track'],
  timestamp: new Date().toISOString(),
  top_result_ids: [],
};

describe('#839: a corrupt search-history sidecar is never silently reset', () => {
  it('a missing file is a first run, not a corruption', async () => {
    // The distinction the whole policy turns on: ENOENT yields an empty
    // history and is allowed to say so plainly.
    assert.deepEqual(await loadSearchHistory(), []);
    assert.deepEqual(await readdir(dir), [], 'nothing to preserve when there is nothing there');
  });

  it('loadSearchHistory throws instead of reporting an empty history', async () => {
    await corruptTheFile();
    await assert.rejects(loadSearchHistory(), (err: unknown) => {
      assert.ok(err instanceof SidecarUnreadableError);
      // The reason is the parse failure itself, not "failed to load".
      assert.match(err.message, /is not valid JSON: .+ at position 120/);
      return true;
    });
  });

  it('the load error names the file and where its bytes went', async () => {
    await corruptTheFile();
    const read = await readSearchHistory();
    assert.equal(read.load_error?.includes(historyFile), true, 'names the file that would not read');
    assert.match(read.load_error ?? '', /is not valid JSON/, 'carries the actual parse failure');
    assert.equal(read.preserved_as, `${historyFile}.corrupt`);
  });

  it('the original bytes are still readable on disk after a failed load', async () => {
    await corruptTheFile();
    await readSearchHistory();
    assert.equal(await readFile(historyFile, 'utf8'), TRUNCATED, 'the file itself is untouched');
    assert.equal(await readFile(`${historyFile}.corrupt`, 'utf8'), TRUNCATED, 'and copied aside byte for byte');
  });

  it('the write path REFUSES: the next append leaves the file alone', async () => {
    await corruptTheFile();
    await assert.rejects(appendSearchHistory(newEntry), SidecarUnreadableError);
    assert.equal(
      await readFile(historyFile, 'utf8'),
      TRUNCATED,
      'refusing means the corrupt file still holds the bytes it had, not a valid store holding one new entry',
    );
  });

  it('an ordinary search records nothing and destroys nothing', async () => {
    // The exact pre-fix reproduction from the issue: corrupt the file, then run
    // a search, and the store came back as a valid JSON file with one entry.
    await corruptTheFile();
    await recordSearch({ query: 'boards of canada', types: ['track'], items: [] });
    assert.equal(await readFile(historyFile, 'utf8'), TRUNCATED, 'the search did not write over the store');
    assert.equal(await readFile(`${historyFile}.corrupt`, 'utf8'), TRUNCATED, 'the preserved copy still has the bytes');
  });

  it('the search itself still succeeds while the store is unreadable', async () => {
    // recordSearch is documented never to throw: history is an aid, and a
    // broken history file must not break searching.
    await corruptTheFile();
    await recordSearch({ query: 'boards of canada', types: ['track'], items: [] });
    await recordSearch({ query: 'aphex twin', types: ['track'], items: [] });
  });

  it('one corruption episode preserves one copy, however many searches run', async () => {
    await corruptTheFile();
    for (let i = 0; i < 5; i += 1) await recordSearch({ query: `q${i}`, types: ['track'], items: [] });
    assert.deepEqual(
      (await readdir(dir)).sort(),
      ['search-history.json', 'search-history.json.corrupt'],
      'every search loads this store; five identical .corrupt.N files would be noise in the user\'s data dir',
    );
  });

  it('refused writes are reported once the file is readable again', async () => {
    // The gap the preserved copy cannot repair: the searches that were dropped
    // while it was corrupt. Silently absent is the one answer that must not
    // stand, because after a repair the history looks complete again.
    await corruptTheFile();
    await recordSearch({ query: 'a', types: ['track'], items: [] });
    await recordSearch({ query: 'b', types: ['track'], items: [] });
    await writeFile(historyFile, JSON.stringify(REAL_HISTORY), 'utf8');

    const read = await readSearchHistory();
    assert.equal(read.entries.length, 3);
    assert.equal(read.refused_writes?.count, 2, 'both dropped searches are named');
    assert.equal(read.refused_writes?.preserved_as, `${historyFile}.corrupt`);

    const again = await readSearchHistory();
    assert.equal(again.refused_writes, undefined, 'reported once — it is a report, not a running total');
  });

  it('a fresh corruption after a repair is preserved again', async () => {
    await corruptTheFile();
    await readSearchHistory();
    await writeFile(historyFile, JSON.stringify(REAL_HISTORY), 'utf8');
    assert.equal((await readSearchHistory()).entries.length, 3, 'the episode ended, so the memo cleared');

    await corruptTheFile('{"id":"tr');
    const read = await readSearchHistory();
    assert.equal(read.preserved_as, `${historyFile}.corrupt.1`, 'the new corruption gets its own copy');
    assert.equal(await readFile(`${historyFile}.corrupt.1`, 'utf8'), '{"id":"tr');
  });

  it('valid JSON in the wrong shape is corruption, not an empty store', async () => {
    // The subtle half: `{"entries": "oops"}` parses. Pre-fix this hit
    // `if (!Array.isArray(arr)) return []` — the same silent reset by a
    // different route.
    await corruptTheFile(JSON.stringify({ entries: 'not an array' }));
    const read = await readSearchHistory();
    assert.match(read.load_error ?? '', /is not a search-history store/);
    assert.equal(await readFile(historyFile, 'utf8'), JSON.stringify({ entries: 'not an array' }));
  });

  it('a single unusable row fails the whole store rather than vanishing', async () => {
    // Dropping the row would be the same coercion one level down: the entry
    // disappears and the store keeps reading as complete.
    await corruptTheFile(JSON.stringify([REAL_HISTORY[0], { id: 'sh_bad', query: 'x' }]));
    const read = await readSearchHistory();
    assert.match(read.load_error ?? '', /entry 1 has no string "timestamp"/);
    assert.equal(await readFile(historyFile, 'utf8'), JSON.stringify([REAL_HISTORY[0], { id: 'sh_bad', query: 'x' }]));
  });

  it('an unreadable path (not a parse failure) is reported the same way', async () => {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = join(blocker, 'search-history.json');
    const read = await readSearchHistory();
    assert.match(read.load_error ?? '', /read failed: ENOTDIR/);
    assert.match(read.load_error ?? '', /still in place|preserved at/);
  });
});

describe('#839: the readers say so', () => {
  it('search_history reports load_error, not a count of zero', async () => {
    await corruptTheFile();
    const out = await harness()('search_history', {});
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.error, 'load_error');
    assert.equal(out.structuredContent?.count, null, 'null, not 0: zero is what an empty store really says');
    assert.equal(out.structuredContent?.total, null);
    assert.equal(out.structuredContent?.entries, null);
    assert.match(out.content[0]!.text, /could not be read/);
    assert.match(out.content[0]!.text, /Nothing was deleted/);
    assert.match(out.content[0]!.text, new RegExp(historyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('search_history still reports 0 for a genuinely empty store', async () => {
    // The other half of the contract, and the one a lazy fix breaks: an empty
    // history must still read as empty, or the warning means nothing.
    const out = await harness()('search_history', {});
    assert.equal(out.structuredContent?.ok, true);
    assert.equal(out.structuredContent?.count, 0);
    assert.match(out.content[0]!.text, /No search history/);
  });

  it('search_rerun reports load_error and issues no request', async () => {
    const registered: Registered[] = [];
    const gets: string[] = [];
    const client = {
      async get(p: string) { gets.push(p); return { tracks: { items: [] } }; },
    } as unknown as SpotifyClient;
    const server = {
      tool(name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: (args: unknown) => Promise<ToolResult>) {
        registered.push({ name, schema, handler });
      },
    } as unknown as McpServer;
    registerSearchHistoryTools(server, client);
    const rerun = registered.find((r) => r.name === 'search_rerun')!;

    await corruptTheFile();
    const out = await rerun.handler(z.object(rerun.schema).parse({ history_id: 'sh_1' }));
    assert.equal(out.structuredContent?.ok, false);
    assert.equal(out.structuredContent?.error, 'load_error');
    assert.match(out.content[0]!.text, /could not be read/);
    assert.deepEqual(gets, [], 'a store it could not read cannot resolve an id, so it must not guess one');
  });

  it('search_history names the dropped searches in prose and payload', async () => {
    const invoke = harness();
    await corruptTheFile();
    await recordSearch({ query: 'a', types: ['track'], items: [] });
    await writeFile(historyFile, JSON.stringify(REAL_HISTORY), 'utf8');

    const out = await invoke('search_history', {});
    assert.equal(out.structuredContent?.ok, true);
    assert.equal((out.structuredContent?.refused_writes as { count: number }).count, 1);
    assert.match(out.content[0]!.text, /1 search was not recorded/);
    assert.match(out.content[0]!.text, /preserved at/);
  });

  it('a healthy store is unaffected', async () => {
    await writeFile(historyFile, JSON.stringify(REAL_HISTORY), 'utf8');
    const out = await harness()('search_history', {});
    assert.equal(out.structuredContent?.ok, true);
    assert.equal(out.structuredContent?.count, 3);
    assert.equal(out.structuredContent?.refused_writes, undefined);
    assert.doesNotMatch(out.content[0]!.text, /could not be read/);
    assert.equal((await readdir(dir)).length, 1, 'a healthy load preserves nothing');
  });
});
