/**
 * #752: import_profile_state — a dry_run that writes nothing, a merge that
 * unions each store on its own keys, and an overwrite that keeps what it
 * replaced.
 *
 * Every test here points the sidecar paths at its own scratch directory, so
 * a regression that writes to the wrong place is visible rather than silent.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
function harness() {
  const registered: RegisteredTool[] = [];
  const server = {
    tool(name: string, _d: string, schema: z.ZodRawShape, h: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler: h });
    },
    registerTool(name: string, cfg: { description?: string; inputSchema?: z.ZodType }, h: RegisteredTool['handler']) {
      registered.push({ name, validate: (a) => (cfg.inputSchema as z.ZodType).parse(a), handler: h });
    },
  } as unknown as McpServer;
  // import_profile_state never calls Spotify; the client is a shape-only stub.
  registerPortabilityTools(server, {} as SpotifyClient);
  return {
    invoke: async (args: Record<string, unknown>) => {
      const t = registered.find((x) => x.name === 'import_profile_state');
      assert.ok(t, 'import_profile_state registered');
      return t.handler(t.validate(args));
    },
  };
}

const textOf = (o: { content: Array<{ text: string }> }) => o.content[0].text;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const historyEntry = (id: string, ageDays: number) => ({ id, query: `q-${id}`, timestamp: daysAgo(ageDays), top_result_ids: [] });

let dir: string;
let scenesFile: string;
let historyFile: string;
let archive: string;
const { invoke } = harness();

/** Write a profile-state archive carrying exactly the stores a test needs. */
const writeArchive = (stores: Record<string, unknown>) => writeFile(archive, `${JSON.stringify({ schema_version: 1, stores })}\n`);
const readStore = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
/** The plan row for one store out of a tool payload. */
const planRow = (out: { structuredContent?: Record<string, unknown> }, store: string) =>
  ((out.structuredContent?.plan ?? []) as Array<Record<string, unknown>>).find((r) => r.store === store);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'import-profile-state-'));
  scenesFile = join(dir, 'scenes.json');
  historyFile = join(dir, 'search-history.json');
  archive = join(dir, 'state.json');
  // Redirect every store this tool can write, not just the two under test.
  process.env.SPOTIFY_MCP_SCENES_FILE = scenesFile;
  process.env.SPOTIFY_MCP_SEARCH_HISTORY_FILE = historyFile;
  process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = join(dir, 'genre-tags.json');
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(dir, 'playback-ext.json');
  process.env.SPOTIFY_MCP_DATA_DIR = dir;
});

afterEach(async () => {
  for (const key of ['SPOTIFY_MCP_SCENES_FILE', 'SPOTIFY_MCP_SEARCH_HISTORY_FILE', 'SPOTIFY_MCP_GENRE_TAGS_FILE', 'SPOTIFY_MCP_PLAYBACKEXT_FILE', 'SPOTIFY_MCP_DATA_DIR', 'SPOTIFY_MCP_HISTORY_DIR']) {
    delete process.env[key];
  }
  await rm(dir, { recursive: true, force: true });
});

describe('#752 import_profile_state merge semantics', () => {
  it('re-importing the same archive leaves search_history the same length', async () => {
    await writeArchive({ search_history: [historyEntry('sh_a', 1), historyEntry('sh_b', 2)] });

    await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });
    const afterFirst = (await readStore(historyFile)) as unknown[];
    assert.equal(afterFirst.length, 2, 'first import writes both archive entries');

    const second = await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });
    const afterSecond = (await readStore(historyFile)) as unknown[];
    assert.equal(afterSecond.length, 2, 'a second import of the same archive must not duplicate entries');
    assert.deepEqual(afterSecond, afterFirst, 're-importing is idempotent on the store contents');
    assert.equal(planRow(second, 'search_history')?.dropped_duplicates, 2, 'the merge reports the duplicates it dropped');
    assert.equal(planRow(second, 'search_history')?.added, 0, 'nothing new arrives from an archive already imported');
  });

  it('keeps pre-existing scenes when the archive carries the enveloped shape', async () => {
    await writeFile(scenesFile, `${JSON.stringify({ Morning: { volume: 20 } })}\n`);
    await writeArchive({ scenes: { version: 1, scenes: { Evening: { volume: 80 } } } });

    await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });

    const written = await readStore(scenesFile);
    assert.deepEqual(Object.keys(written).sort(), ['scenes', 'version'], 'the store carries the envelope only — no bare keys beside it for loadScenes to read as phantom scenes');
    const store = written.scenes as Record<string, unknown>;
    assert.ok(store.Morning, 'the pre-existing scene survives the merge');
    assert.ok(store.Evening, 'the archived scene is added');
  });

  it('unions scenes on the canonical bare map, incoming winning a conflict', async () => {
    await writeFile(scenesFile, `${JSON.stringify({ Morning: { volume: 20 }, Evening: { volume: 5 } })}\n`);
    await writeArchive({ scenes: { Evening: { volume: 80 }, Night: { volume: 2 } } });

    await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });

    const store = await readStore(scenesFile);
    assert.deepEqual(store, { Morning: { volume: 20 }, Evening: { volume: 80 }, Night: { volume: 2 } });
  });

  it('trims search_history to the 90-day window its reader already applies', async () => {
    await writeArchive({ search_history: [historyEntry('sh_old', 200), historyEntry('sh_fresh', 1)] });

    const out = await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });

    const kept = (await readStore(historyFile)) as unknown[];
    assert.deepEqual(kept.map((e) => (e as { id: string }).id), ['sh_fresh']);
    assert.equal(planRow(out, 'search_history')?.dropped_expired, 1);
  });

  it('keeps an entry whose timestamp cannot be read, and says so', async () => {
    await writeArchive({ search_history: [{ id: 'sh_broken', query: 'q', top_result_ids: [] }] });

    const out = await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });

    const kept = (await readStore(historyFile)) as unknown[];
    assert.equal(kept.length, 1, 'an unreadable timestamp is not grounds for dropping the entry');
    assert.equal(planRow(out, 'search_history')?.unreadable_timestamps, 1);
  });

  it('replaces a mismatched store on merge but keeps the bytes it replaced', async () => {
    const legacy = `${JSON.stringify({ entries: [historyEntry('sh_legacy', 3)] })}\n`;
    await writeFile(historyFile, legacy);
    await writeArchive({ search_history: [historyEntry('sh_new', 1)] });

    const out = await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });

    assert.deepEqual(await readFile(`${historyFile}.bak`, 'utf8'), legacy, 'the replaced store is recoverable from the .bak');
    assert.equal(planRow(out, 'search_history')?.action, 'overwritten');
    assert.equal(planRow(out, 'search_history')?.backup, `${historyFile}.bak`);
    assert.match(textOf(out), /does not match the archive's array shape/);
  });
});

describe('#752 import_profile_state dry_run', () => {
  it('writes nothing and reports the per-store plan', async () => {
    const scenesBefore = `${JSON.stringify({ Morning: { volume: 20 } })}\n`;
    await writeFile(scenesFile, scenesBefore);
    await writeFile(historyFile, `${JSON.stringify([historyEntry('sh_a', 1)])}\n`);
    await writeArchive({
      scenes: { Morning: { volume: 99 }, Evening: { volume: 80 } },
      search_history: [historyEntry('sh_a', 1), historyEntry('sh_b', 2)],
    });
    const before = await stat(scenesFile);

    const out = await invoke({ input_path: archive, mode: 'merge', dry_run: true, response_format: 'concise' });

    assert.equal(await readFile(scenesFile, 'utf8'), scenesBefore, 'dry_run leaves the scenes store byte-identical');
    assert.equal(((await readStore(historyFile)) as unknown[]).length, 1, 'dry_run appends no history entries');
    assert.equal((await stat(scenesFile)).mtimeMs, before.mtimeMs, 'dry_run does not even rewrite the store');
    await assert.rejects(() => stat(`${scenesFile}.bak`), 'dry_run writes no backup');

    assert.equal(out.structuredContent?.dry_run, true);
    assert.equal(out.structuredContent?.executed, false);
    const scenes = planRow(out, 'scenes');
    assert.equal(scenes?.action, 'merged');
    assert.equal(scenes?.existing_keys, 1);
    assert.equal(scenes?.added, 1, 'Evening is the only new scene');
    assert.equal(scenes?.conflicts, 1, 'Morning exists on both sides');
    assert.equal(planRow(out, 'search_history')?.dropped_duplicates, 1);
    assert.ok(!('data' in (scenes ?? {})), 'the plan never echoes the bytes headed for a store');
    assert.match(textOf(out), /\[dry run\] import_profile_state/);
    assert.match(textOf(out), /scenes: 1 existing \+ 1 new, 1 conflict overwritten/);
  });

  it('plans an overwrite without taking it', async () => {
    const scenesBefore = `${JSON.stringify({ Morning: { volume: 20 } })}\n`;
    await writeFile(scenesFile, scenesBefore);
    await writeArchive({ scenes: { Night: { volume: 5 } } });

    const out = await invoke({ input_path: archive, mode: 'overwrite', dry_run: true, response_format: 'concise' });

    assert.equal(await readFile(scenesFile, 'utf8'), scenesBefore);
    const row = planRow(out, 'scenes');
    assert.equal(row?.action, 'overwritten');
    assert.equal(row?.backup, `${scenesFile}.bak`, 'the preview names the backup it would write');
  });
});

describe('#752 import_profile_state overwrite', () => {
  it('writes a 0600 .bak of each store it replaces and reports the path', async () => {
    const scenesBefore = `${JSON.stringify({ Morning: { volume: 20 } })}\n`;
    await writeFile(scenesFile, scenesBefore);
    await writeFile(historyFile, `${JSON.stringify([historyEntry('sh_a', 1)])}\n`);
    await writeArchive({ scenes: { Night: { volume: 5 } }, search_history: [historyEntry('sh_b', 1)] });

    const out = await invoke({ input_path: archive, mode: 'overwrite', response_format: 'concise' });

    assert.deepEqual(await readStore(scenesFile), { Night: { volume: 5 } }, 'overwrite replaces the store');
    assert.deepEqual(await readFile(`${scenesFile}.bak`, 'utf8'), scenesBefore, 'the .bak holds the replaced bytes verbatim');
    assert.equal((await stat(`${scenesFile}.bak`)).mode & 0o777, 0o600, 'the .bak is owner-only');
    assert.deepEqual(
      out.structuredContent?.backups,
      { scenes: `${scenesFile}.bak`, search_history: `${historyFile}.bak` },
    );
    assert.match(textOf(out), new RegExp(`Replaced stores were backed up first: scenes → ${scenesFile.replace(/\//g, '\\/')}\\.bak`));
  });

  it('invents no backup for a store that does not exist yet', async () => {
    await writeArchive({ scenes: { Night: { volume: 5 } } });

    const out = await invoke({ input_path: archive, mode: 'overwrite', response_format: 'concise' });

    assert.equal(planRow(out, 'scenes')?.action, 'created');
    assert.equal(planRow(out, 'scenes')?.backup, null);
    assert.equal(out.structuredContent?.backups, undefined, 'no backup is claimed for a store that had nothing to replace');
    await assert.rejects(() => stat(`${scenesFile}.bak`));
  });

  it('appends the mutation ledger on merge and backs it up on overwrite', async () => {
    const histDir = join(dir, 'history');
    process.env.SPOTIFY_MCP_HISTORY_DIR = histDir;
    const histPath = join(histDir, 'mutations.jsonl');
    await writeArchive({ mutations_history: [{ method: 'PUT', path: '/me/library' }] });

    await invoke({ input_path: archive, mode: 'merge', response_format: 'concise' });
    const ledger = await readFile(histPath, 'utf8');
    assert.equal(ledger.split('\n').filter((l) => l.trim().length > 0).length, 1, 'merge appends rather than replacing');

    await writeFile(histPath, ledger);
    await copyFile(histPath, `${histPath}.keep`);
    const out = await invoke({ input_path: archive, mode: 'overwrite', response_format: 'concise' });
    assert.equal(await readFile(`${histPath}.bak`, 'utf8'), await readFile(`${histPath}.keep`, 'utf8'), 'overwrite keeps the ledger it replaced');
    assert.equal(planRow(out, 'mutations_history')?.action, 'overwritten');
  });
});
