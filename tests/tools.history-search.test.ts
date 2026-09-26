/**
 * Tests for #754: history_search must cover the stores its name promises.
 *
 * Before the fix it read portabilityDir() only, so an operator asking
 * "where is my backup" or "which mutations touched my playlist" was told the
 * history did not exist. These tests pin the three-store union, the scope
 * filter, and — the rule this repo lives by — that a store which could not be
 * read reports an unknown total rather than a zero.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import * as backupModule from '../src/tools/backup.js';
import { registerPortabilityTools } from '../src/tools/portability.js';

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

interface SearchHarness {
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}

function harness(): SearchHarness {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;
  const client = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [] as unknown[],
  };
  registerPortabilityTools(server, client as unknown as SpotifyClient);
  return {
    invoke: async (name, args) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

type Hit = Record<string, unknown>;

interface StoreSummary {
  state: string;
  total: number | null;
  matched: number;
}

interface SearchPayload {
  ok: boolean;
  query: string;
  scope: string;
  dirs: { portability: string; backups: string; history: string };
  total: number;
  matched_count: number;
  sources: Record<string, StoreSummary>;
  hits?: Hit[];
  hits_truncated: boolean;
  unreadable_sources: number;
  notes: string[];
  /** Pre-#754 field: the portability-only filename list, kept here so a red
 *  run against origin/main fails on the missing hit rather than on a
 *  missing key. */
  files?: string[];
}

/** Every hit a search returned, whatever shape the server answered in. */
function hitsOf(payload: SearchPayload, source?: string): Hit[] {
  const hits = payload.hits ?? (payload.files ?? []).map((name) => ({ source: 'portability', name }));
  return source ? hits.filter((h) => h.source === source) : hits;
}

async function search(args: Record<string, unknown>): Promise<{ payload: SearchPayload; prose: string }> {
  const out = await harness().invoke('history_search', args);
  return { payload: out.structuredContent as unknown as SearchPayload, prose: out.content[0]!.text };
}

let root = '';
let portabilityRoot = '';
let backupRoot = '';
let historyRoot = '';

const ENV_KEYS = ['SPOTIFY_MCP_PORTABILITY_DIR', 'SPOTIFY_MCP_BACKUP_DIR', 'SPOTIFY_MCP_HISTORY_DIR'] as const;
let savedEnv: Record<string, string | undefined> = {};

/** Point every store history_search reads at a scratch directory. */
async function useScratchStores(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'history-search-'));
  portabilityRoot = join(root, 'portability');
  backupRoot = join(root, 'backups');
  historyRoot = join(root, 'history');
  process.env.SPOTIFY_MCP_PORTABILITY_DIR = portabilityRoot;
  process.env.SPOTIFY_MCP_BACKUP_DIR = backupRoot;
  process.env.SPOTIFY_MCP_HISTORY_DIR = historyRoot;
}

async function writeFileIn(dir: string, name: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), body, 'utf8');
}

async function writeLedger(lines: unknown[]): Promise<void> {
  await mkdir(historyRoot, { recursive: true });
  await writeFile(
    join(historyRoot, 'mutations.jsonl'),
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
    'utf8',
  );
}

const PLAYLIST_MUTATION = {
  ts: '2026-08-01T10:00:00.000Z',
  who: 'agent',
  method: 'POST',
  path: '/playlists/{id}/items',
  target: 'aaaa1111bbbb2222',
};
const LIBRARY_MUTATION = {
  ts: '2026-08-02T10:00:00.000Z',
  who: 'agent',
  method: 'DELETE',
  path: '/me/tracks',
  target: 'cccc3333dddd4444',
};

beforeEach(async () => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  await useScratchStores();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const previous = savedEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

describe('history_search store coverage (#754)', () => {
  it('finds a backup snapshot and tags the hit with the backups store', async () => {
    await writeFileIn(backupRoot, 'backup-2026-08-01-1.json', '{"_meta":{}}');
    await writeFileIn(portabilityRoot, 'library.json', '{}');

    const { payload } = await search({ query: 'backup' });

    const backupHits = hitsOf(payload, 'backups');
    assert.equal(backupHits.length, 1, 'exactly one backup hit');
    assert.equal(backupHits[0]!.name, 'backup-2026-08-01-1.json');
    assert.equal(backupHits[0]!.path, join(backupRoot, 'backup-2026-08-01-1.json'));
    assert.equal(payload.sources.backups!.matched, 1);
    assert.equal(payload.sources.backups!.total, 1);
  });

  it('returns the mutation records whose route matches, not just a file name', async () => {
    await writeLedger([PLAYLIST_MUTATION, LIBRARY_MUTATION]);

    const { payload } = await search({ query: 'playlists' });

    const historyHits = hitsOf(payload, 'history');
    assert.equal(historyHits.length, 1);
    assert.equal(historyHits[0]!.path, '/playlists/{id}/items');
    assert.equal(historyHits[0]!.method, 'POST');
    assert.equal(historyHits[0]!.ts, '2026-08-01T10:00:00.000Z');
    assert.equal(payload.sources.history!.total, 2, 'both records were read; one matched');
    assert.equal(payload.sources.history!.matched, 1);
  });

  it('matches a ledger record by method, fingerprint and timestamp too', async () => {
    await writeLedger([PLAYLIST_MUTATION, LIBRARY_MUTATION]);

    for (const [query, expectedPath] of [
      ['delete', '/me/tracks'],
      ['aaaa1111bbbb2222', '/playlists/{id}/items'],
      ['2026-08-01', '/playlists/{id}/items'],
    ] as const) {
      const { payload } = await search({ query, scope: 'history' });
      const historyHits = hitsOf(payload, 'history');
      assert.equal(historyHits.length, 1, `query ${query} matches exactly one record`);
      assert.equal(historyHits[0]!.path, expectedPath);
    }
  });

  it('scope:portability searches the portability store and nothing else', async () => {
    await writeFileIn(backupRoot, 'backup-2026-08-01-1.json', '{}');
    await writeLedger([PLAYLIST_MUTATION, LIBRARY_MUTATION]);
    await writeFileIn(portabilityRoot, 'backup-helper-notes.json', '{}');

    const scoped = await search({ query: 'backup', scope: 'portability' });
    assert.equal(scoped.payload.sources.backups!.state, 'skipped');
    assert.equal(scoped.payload.sources.history!.state, 'skipped');
    assert.equal(hitsOf(scoped.payload).every((h) => h.source === 'portability'), true);
    assert.equal(hitsOf(scoped.payload).length, 1);
    assert.equal(hitsOf(scoped.payload)[0]!.name, 'backup-helper-notes.json');

    // The same query against the backups store DOES reach the snapshot, so the
    // scope filter above is a real filter and not an empty result.
    const backups = await search({ query: 'backup', scope: 'backups' });
    assert.equal(hitsOf(backups.payload).length, 1);
    assert.equal(hitsOf(backups.payload)[0]!.source, 'backups');
  });

  it('reports a store it could not read as unknown, never as zero', async () => {
    // A regular file where a directory is expected: the listing genuinely
    // cannot be read, which is not the same as holding nothing.
    const filePath = join(root, 'backups-is-a-file');
    await writeFile(filePath, 'not a directory', 'utf8');
    process.env.SPOTIFY_MCP_BACKUP_DIR = filePath;
    process.env.SPOTIFY_MCP_HISTORY_DIR = filePath;

    const { payload, prose } = await search({ query: 'backup' });

    assert.equal(payload.sources.backups!.state, 'unreadable');
    assert.equal(payload.sources.backups!.total, null, 'an unread store has no count, not a count of 0');
    assert.equal(payload.sources.history!.total, null);
    assert.equal(payload.unreadable_sources, 2);
    assert.match(prose, /could not be read/);
    assert.match(prose, /unknown, not zero/);
  });

  it('reports a store that does not exist as absent, with a zero count', async () => {
    await rm(portabilityRoot, { recursive: true, force: true });
    await rm(backupRoot, { recursive: true, force: true });
    await rm(historyRoot, { recursive: true, force: true });

    const { payload } = await search({ query: 'anything' });

    for (const store of ['portability', 'backups', 'history'] as const) {
      assert.equal(payload.sources[store]!.state, 'absent');
      assert.equal(payload.sources[store]!.total, 0);
      assert.equal(payload.sources[store]!.matched, 0);
    }
    assert.equal(payload.total, 0);
    assert.equal(hitsOf(payload).length, 0);
  });

  it('echoes only whitelisted ledger fields back to the caller', async () => {
    await writeLedger([{ ...PLAYLIST_MUTATION, access_token: 'super-secret' }]);

    const { payload } = await search({ query: 'playlists', scope: 'history' });

    const hit = hitsOf(payload, 'history')[0]!;
    assert.equal(hit.path, '/playlists/{id}/items');
    assert.equal('access_token' in hit, false, 'unknown ledger fields are not echoed');
  });

  it('applies the query to every store and counts non-matching candidates', async () => {
    await writeFileIn(backupRoot, 'backup-2026-08-01-1.json', '{}');
    await writeFileIn(portabilityRoot, 'library.json', '{}');
    await writeLedger([PLAYLIST_MUTATION, LIBRARY_MUTATION]);

    const { payload } = await search({ query: 'no-such-thing' });

    assert.equal(payload.matched_count, 0);
    assert.equal(hitsOf(payload).length, 0);
    assert.equal(payload.total, 4, '1 portability + 1 backup + 2 ledger records were examined');
  });
});

describe('readBackupStore (#754)', () => {
  it('lists only store-shaped files, name-sorted, with the stats it could read', async () => {
    await writeFileIn(backupRoot, 'backup-2026-08-02-1.json', '{}');
    await writeFileIn(backupRoot, 'backup-2026-08-01-2.json', '{}');
    await writeFileIn(backupRoot, 'notes.json', '{}');

    const store = await backupModule.readBackupStore({ SPOTIFY_MCP_BACKUP_DIR: backupRoot });

    assert.equal(store.state, 'ok');
    assert.deepEqual(store.artifacts?.map((a) => a.name), ['backup-2026-08-01-2.json', 'backup-2026-08-02-1.json']);
    assert.equal(store.artifacts?.[0]!.bytes, 2);
    assert.equal(typeof store.artifacts?.[0]!.mtime, 'string');
    assert.equal(store.artifacts?.[0]!.regular_file, true);
  });

  it('separates an absent store from one that cannot be read', async () => {
    const absent = await backupModule.readBackupStore({ SPOTIFY_MCP_BACKUP_DIR: join(root, 'never-written') });
    assert.equal(absent.state, 'absent');
    assert.deepEqual(absent.artifacts, []);

    const filePath = join(root, 'a-file');
    await writeFile(filePath, 'x', 'utf8');
    const unreadable = await backupModule.readBackupStore({ SPOTIFY_MCP_BACKUP_DIR: filePath });
    assert.equal(unreadable.state, 'unreadable');
    assert.equal(unreadable.artifacts, null, 'a failed listing is not an empty listing');
  });

  it('reports a directory wearing a backup name as not a regular file', async () => {
    await mkdir(join(backupRoot, 'backup-2026-08-01-1.json'), { recursive: true });

    const store = await backupModule.readBackupStore({ SPOTIFY_MCP_BACKUP_DIR: backupRoot });

    assert.equal(store.state, 'ok');
    assert.equal(store.artifacts?.length, 1);
    assert.equal(store.artifacts?.[0]!.regular_file, false);
  });
});
