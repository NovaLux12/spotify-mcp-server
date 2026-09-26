/**
 * #754: history_search searched one directory while its name and description
 * promised portability + backups + the mutation ledger.
 *
 * The bar these cases hold: every source the tool says it searches is really
 * searched, the scope filter really filters, and a source that could not be
 * read is reported as unread/absent — never coerced into "0 matches", which is
 * what the pre-#754 implementation did for every source but the first.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerPortabilityTools } from '../src/tools/portability.js';

interface RegisteredTool {
  name: string;
  validate: (a: Record<string, unknown>) => Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }>; structuredContent?: Record<string, unknown> }>;
}

const noopClient = {
  get: async () => null,
  getAllPages: async () => [],
  post: async () => null,
  put: async () => null,
  putRaw: async () => undefined,
  delete: async () => null,
} as unknown as SpotifyClient;

function harness() {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
    registerTool(name: string, cfg: { description?: string; inputSchema?: z.ZodType }, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => (cfg.inputSchema as z.ZodType).parse(a), handler });
    },
  } as unknown as McpServer;
  registerPortabilityTools(server, noopClient);
  return {
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool ${name} registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

type Report = {
  source: string;
  state: string;
  path: string;
  total?: number;
  matched_count?: number;
  returned: number;
  truncated: boolean;
  reason?: string;
  records_searched?: number;
  records_read_limit?: number;
  recording_enabled?: boolean;
};
type Payload = {
  scope: string;
  matched_count: number;
  hit_limit: number;
  sources: Report[];
  hits: Array<{ source: string; [key: string]: unknown }>;
  notes: string[];
};

const textOf = (o: { content: Array<{ text: string }> }) => o.content[0]!.text;

/**
 * A scratch tree holding one file per source. `withStores` points every
 * accessor history_search reaches at it and restores the process env after,
 * because portabilityDir()/backupDir()/historyFilePath() all read process.env
 * at call time.
 */
async function withStores<T>(seed: (root: string) => Promise<void>, run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'history-search-'));
  const portability = join(root, 'portability');
  const backups = join(root, 'backups');
  const historyDir = join(root, 'history');
  await mkdir(portability);
  await mkdir(backups);
  await mkdir(historyDir);
  await seed(root);
  const keys = ['SPOTIFY_MCP_PORTABILITY_DIR', 'SPOTIFY_MCP_BACKUP_DIR', 'SPOTIFY_MCP_HISTORY_DIR', 'SPOTIFY_MCP_HISTORY'] as const;
  const saved = new Map(keys.map((k) => [k, process.env[k]] as const));
  process.env.SPOTIFY_MCP_PORTABILITY_DIR = portability;
  process.env.SPOTIFY_MCP_BACKUP_DIR = backups;
  process.env.SPOTIFY_MCP_HISTORY_DIR = historyDir;
  // Default configuration: mutation recording is opt-in and off.
  delete process.env.SPOTIFY_MCP_HISTORY;
  try {
    return await run(root);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const writeLedger = (root: string, lines: unknown[]) =>
  writeFile(join(root, 'history', 'mutations.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

const LEDGER_LINE = { ts: '2026-09-20T10:00:00.000Z', who: 'batch-x', method: 'DELETE', path: '/playlists/{id}/tracks', target: '0f1e2d3c4b5a6978' };

describe('history_search searches every source its name promises (#754)', () => {
  it('finds a backup by filename even though it is not a portability file', async () => {
    await withStores(
      async (root) => {
        await writeFile(join(root, 'portability', 'library.json'), '{}', 'utf8');
        await writeFile(join(root, 'backups', 'backup-2026-09-20-01.json'), '{}', 'utf8');
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'backup' });
        const payload = out.structuredContent as unknown as Payload;
        const backup = payload.sources.find((s) => s.source === 'backups');
        assert.ok(backup, 'backups is one of the searched sources');
        assert.equal(backup.state, 'ok');
        assert.equal(backup.matched_count, 1);
        assert.deepEqual(payload.hits.filter((h) => h.source === 'backups'), [{ source: 'backups', name: 'backup-2026-09-20-01.json' }]);
        // The portability directory held no name containing "backup": the hit
        // above came from the backups directory, not from a lucky overlap.
        assert.equal(payload.sources.find((s) => s.source === 'portability')!.matched_count, 0);
      },
    );
  });

  it('content-matches the mutation ledger, which has no filenames to match', async () => {
    await withStores(
      async (root) => {
        await writeLedger(root, [
          { ts: '2026-09-19T10:00:00.000Z', who: 'agent', method: 'POST', path: '/playlists/{id}/items', target: 'aaaa' },
          LEDGER_LINE,
        ]);
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'batch-x' });
        const payload = out.structuredContent as unknown as Payload;
        const ledger = payload.sources.find((s) => s.source === 'history');
        assert.ok(ledger, 'history is one of the searched sources');
        assert.equal(ledger.state, 'ok');
        assert.equal(ledger.matched_count, 1);
        const hit = payload.hits.find((h) => h.source === 'history');
        assert.ok(hit, 'the matching ledger record is returned, not just a count');
        assert.equal(hit.path, '/playlists/{id}/tracks');
        assert.equal(hit.snapshot_id, undefined);
      },
    );
  });

  it('searches the ledger in the default configuration, where recording is off', async () => {
    // SPOTIFY_MCP_HISTORY is opt-in and off by default; a ledger written by an
    // earlier session is still on disk and still has to be searchable.
    await withStores(
      async (root) => {
        await writeLedger(root, [LEDGER_LINE]);
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'batch-x' });
        const payload = out.structuredContent as unknown as Payload;
        const ledger = payload.sources.find((s) => s.source === 'history');
        assert.equal(ledger!.state, 'ok');
        assert.equal(ledger!.matched_count, 1);
        assert.equal(ledger!.recording_enabled, false);
        assert.match(textOf(out), /no NEW mutations are being recorded/);
      },
    );
  });

  it('reports how much of the ledger it could read instead of inventing a total', async () => {
    await withStores(
      async (root) => {
        await writeLedger(root, [LEDGER_LINE]);
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'batch-x' });
        const ledger = (out.structuredContent as unknown as Payload).sources.find((s) => s.source === 'history')!;
        // The reader tails a bounded window, so the ledger's record count is
        // not knowable from here — `total` must be absent, not 0 or 1.
        assert.equal('total' in ledger, false);
        assert.equal(ledger.records_searched, 1);
        assert.equal(ledger.records_read_limit, 500);
        assert.match(textOf(out), /older records were not searched/);
      },
    );
  });
});

describe('history_search scope filter (#754)', () => {
  const seedThreeSources = async (root: string) => {
    // "x" appears in a file name in each of the two directories and in a field
    // of one ledger record, so an over-broad search is visible, not invisible.
    await writeFile(join(root, 'portability', 'taxonomy-x.json'), '{}', 'utf8');
    await writeFile(join(root, 'backups', 'backup-x.json'), '{}', 'utf8');
    await writeLedger(root, [LEDGER_LINE]);
  };

  it('portability scope returns no backup and no history hits', async () => {
    await withStores(seedThreeSources, async () => {
      const out = await harness().invoke('history_search', { query: 'x', scope: 'portability' });
      const payload = out.structuredContent as unknown as Payload;
      assert.deepEqual(payload.sources.map((s) => s.source), ['portability']);
      assert.equal(payload.sources[0]!.matched_count, 1);
      assert.deepEqual(payload.hits, [{ source: 'portability', name: 'taxonomy-x.json' }]);
    });
  });

  it('backups scope reaches the backups directory and nothing else', async () => {
    await withStores(seedThreeSources, async () => {
      const payload = (await harness().invoke('history_search', { query: 'x', scope: 'backups' })).structuredContent as unknown as Payload;
      assert.deepEqual(payload.sources.map((s) => s.source), ['backups']);
      assert.deepEqual(payload.hits, [{ source: 'backups', name: 'backup-x.json' }]);
    });
  });

  it('history scope reaches the ledger and nothing else', async () => {
    await withStores(seedThreeSources, async () => {
      const payload = (await harness().invoke('history_search', { query: 'x', scope: 'history' })).structuredContent as unknown as Payload;
      assert.deepEqual(payload.sources.map((s) => s.source), ['history']);
      assert.equal(payload.hits.length, 1);
      assert.equal(payload.hits[0]!.source, 'history');
    });
  });

  it('the default scope is every source', async () => {
    await withStores(seedThreeSources, async () => {
      const payload = (await harness().invoke('history_search', { query: 'x' })).structuredContent as unknown as Payload;
      assert.equal(payload.scope, 'all');
      assert.deepEqual(payload.sources.map((s) => s.source), ['portability', 'backups', 'history']);
      assert.deepEqual([...new Set(payload.hits.map((h) => h.source))].sort(), ['backups', 'history', 'portability']);
    });
  });
});

describe('history_search reports an unreadable source as unreadable (#754)', () => {
  it('a missing backups directory is absent, not an empty search', async () => {
    await withStores(
      async (root) => {
        await writeFile(join(root, 'portability', 'library.json'), '{}', 'utf8');
        await rm(join(root, 'backups'), { recursive: true, force: true });
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'library' });
        const payload = out.structuredContent as unknown as Payload;
        const backups = payload.sources.find((s) => s.source === 'backups')!;
        assert.equal(backups.state, 'absent');
        // A source that was never read carries no count at all.
        assert.equal('matched_count' in backups, false);
        assert.equal('total' in backups, false);
        assert.match(textOf(out), /backups: absent \(no such directory\)/);
        assert.equal(payload.matched_count, 1);
      },
    );
  });

  it('a missing ledger is absent, and the reply says it was not searched', async () => {
    await withStores(
      async (root) => {
        await writeFile(join(root, 'portability', 'library.json'), '{}', 'utf8');
        void root;
      },
      async () => {
        const out = await harness().invoke('history_search', {});
        const ledger = (out.structuredContent as unknown as Payload).sources.find((s) => s.source === 'history')!;
        assert.equal(ledger.state, 'absent');
        assert.equal('matched_count' in ledger, false);
        assert.match(textOf(out), /nothing is known about it/);
      },
    );
  });
});

describe('history_search return cap is disclosed, not silent (#754)', () => {
  it('counts every match while returning at most the hit limit', async () => {
    await withStores(
      async (root) => {
        await writeFile(join(root, 'portability', 'library.json'), '{}', 'utf8');
        for (let i = 0; i < 60; i++) await writeFile(join(root, 'backups', `backup-x-${String(i).padStart(2, '0')}.json`), '{}', 'utf8');
      },
      async () => {
        const out = await harness().invoke('history_search', { query: 'backup' });
        const payload = out.structuredContent as unknown as Payload;
        const backups = payload.sources.find((s) => s.source === 'backups')!;
        assert.equal(backups.total, 60);
        assert.equal(backups.matched_count, 60);
        assert.equal(backups.returned, 50);
        assert.equal(backups.truncated, true);
        assert.equal(payload.hit_limit, 50);
        assert.match(textOf(out), /counts are complete, the list is not/);
      },
    );
  });
});
