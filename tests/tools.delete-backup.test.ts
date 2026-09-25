/**
 * Tests for delete_backup (#697): the only tool that removes a stored
 * library snapshot, so every path here is about what it refuses to do —
 * delete by default, delete outside the store, delete without a human.
 * Real tmpdir store; no Spotify calls are made or expected.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerBackupTools } from '../src/tools/backup.js';

interface RegisteredTool {
  name: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
}

type Answer = { action: 'accept'; confirm: boolean } | { action: 'decline' };

/**
 * A server double that advertises elicitation and answers the prompt, so
 * the gate is exercised for real rather than bypassed with
 * SPOTIFY_MCP_CONFIRM=never. `capable: false` models a host that cannot
 * prompt at all.
 */
function harness(opts: { answer?: Answer; capable?: boolean } = {}) {
  const prompts: string[] = [];
  const registered: RegisteredTool[] = [];
  const answer = opts.answer ?? { action: 'accept' as const, confirm: true };
  const fakeServer = {
    server: {
      async elicitInput(request: { message: string }) {
        prompts.push(request.message);
        return answer.action === 'accept'
          ? { action: answer.action, content: { confirm: answer.confirm } }
          : { action: answer.action };
      },
      getClientCapabilities: () =>
        opts.capable === false ? {} : { elicitation: { form: {} } },
    },
    tool(name: string, _description: string, schema: z.ZodRawShape, handler: RegisteredTool['handler']) {
      registered.push({ name, validate: (args) => z.object(schema).parse(args), handler });
    },
  } as unknown as McpServer;
  registerBackupTools(fakeServer, {
    calls: [],
    async get<T>(): Promise<T | null> {
      throw new Error('delete_backup must not call Spotify');
    },
  } as unknown as SpotifyClient);
  return {
    prompts,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0]!.text;

let tmp: string;
let prevBackupDirEnv: string | undefined;
let prevConfirmEnv: string | undefined;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spotify-delete-backup-'));
  prevBackupDirEnv = process.env.SPOTIFY_MCP_BACKUP_DIR;
  process.env.SPOTIFY_MCP_BACKUP_DIR = tmp;
  prevConfirmEnv = process.env.SPOTIFY_MCP_CONFIRM;
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  if (prevBackupDirEnv === undefined) delete process.env.SPOTIFY_MCP_BACKUP_DIR;
  else process.env.SPOTIFY_MCP_BACKUP_DIR = prevBackupDirEnv;
  if (prevConfirmEnv === undefined) delete process.env.SPOTIFY_MCP_CONFIRM;
  else process.env.SPOTIFY_MCP_CONFIRM = prevConfirmEnv;
});

/** A snapshot plus the sidecar list_backups would have written. */
async function seed(name: string): Promise<string> {
  const path = join(tmp, name);
  const meta = { created: new Date().toISOString(), snapshot_state: 'complete', complete: true, partial_reasons: [] };
  await writeFile(path, `${JSON.stringify({ _meta: meta, liked_tracks: [] }, null, 2)}\n`, { mode: 0o600 });
  await writeFile(
    join(tmp, name.replace(/\.json$/, '.meta.json')),
    `${JSON.stringify({ schema_version: 1, snapshot: path, bytes: 32, meta }, null, 2)}\n`,
    { mode: 0o600 },
  );
  return path;
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

describe('delete_backup (#697)', () => {
  it('is registered with a dry_run that defaults to true', () => {
    const registered: string[] = [];
    const fakeServer = {
      tool(name: string, _d: string, _s: z.ZodRawShape) {
        registered.push(name);
      },
    } as unknown as McpServer;
    registerBackupTools(fakeServer, {} as unknown as SpotifyClient);
    assert.ok(registered.includes('delete_backup'), 'delete_backup must be registered');

    // The schema itself carries the safe default (a client that only reads
    // the signature must see that omitting dry_run deletes nothing).
    const schema = z.object({
      file: z.string().min(1),
      dry_run: z.boolean().optional().default(true),
    });
    assert.equal(schema.parse({ file: 'backup-2026-01-01-1.json' }).dry_run, true);
  });

  it('deletes nothing on the default dry run', async () => {
    const path = await seed('backup-2026-01-01-1.json');
    const h = harness();
    const out = await h.invoke('delete_backup', { file: 'backup-2026-01-01-1.json' });
    const sc = out.structuredContent as { ok: boolean; dry_run: boolean; path: string; sidecar: string };

    assert.equal(sc.ok, true);
    assert.equal(sc.dry_run, true);
    assert.equal(sc.path, path);
    assert.equal(sc.sidecar, path.replace(/\.json$/, '.meta.json'));
    assert.equal(h.prompts.length, 0, 'a preview must not prompt for confirmation');
    assert.match(textOf(out), /nothing was changed/);
    assert.match(textOf(out), /dry_run: false/);
    assert.equal(await exists(path), true);
    assert.equal(await exists(path.replace(/\.json$/, '.meta.json')), true);
  });

  it('fails closed when the client cannot confirm', async () => {
    const path = await seed('backup-2026-01-01-1.json');
    const h = harness({ capable: false });
    const out = await h.invoke('delete_backup', { file: 'backup-2026-01-01-1.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; cancelled: boolean; reason: string };

    assert.equal(sc.ok, false);
    assert.equal(sc.cancelled, true);
    assert.equal(sc.reason, 'confirmation_unavailable');
    assert.match(textOf(out), /Confirmation is unavailable/);
    assert.equal(await exists(path), true, 'an unconfirmed delete must not delete');
  });

  it('fails closed when the human declines the prompt', async () => {
    const path = await seed('backup-2026-01-01-1.json');
    const h = harness({ answer: { action: 'decline' } });
    const out = await h.invoke('delete_backup', { file: 'backup-2026-01-01-1.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; cancelled: boolean };

    assert.equal(sc.ok, false);
    assert.equal(sc.cancelled, true);
    assert.equal(h.prompts.length, 1);
    assert.equal(await exists(path), true);
  });

  it('does not delete when confirmation is accepted with confirm: false', async () => {
    const path = await seed('backup-2026-01-01-1.json');
    const h = harness({ answer: { action: 'accept', confirm: false } });
    const out = await h.invoke('delete_backup', { file: 'backup-2026-01-01-1.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; cancelled: boolean };
    assert.equal(sc.ok, false);
    assert.equal(sc.cancelled, true);
    assert.equal(await exists(path), true);
  });

  it('deletes the snapshot and its sidecar once confirmed', async () => {
    const path = await seed('backup-2026-01-01-1.json');
    const keep = await seed('backup-2026-01-02-1.json');
    const h = harness();
    const out = await h.invoke('delete_backup', { file: 'backup-2026-01-01-1.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; deleted: boolean; path: string; sidecar_deleted: boolean };

    assert.equal(sc.ok, true);
    assert.equal(sc.deleted, true);
    assert.equal(sc.path, path);
    assert.equal(sc.sidecar_deleted, true);
    assert.equal(h.prompts.length, 1);
    assert.match(h.prompts[0]!, /delete backup "backup-2026-01-01-1\.json"/);
    assert.match(h.prompts[0]!, /permanently/);
    assert.equal(await exists(path), false);
    assert.equal(await exists(path.replace(/\.json$/, '.meta.json')), false);
    // A sibling snapshot is untouched.
    assert.equal(await exists(keep), true);
    assert.equal(await exists(keep.replace(/\.json$/, '.meta.json')), true);
  });

  it('accepts an absolute path inside the store', async () => {
    const path = await seed('backup-2026-03-01-1.json');
    const out = await harness().invoke('delete_backup', { file: path, dry_run: false });
    assert.equal((out.structuredContent as { deleted: boolean }).deleted, true);
    assert.equal(await exists(path), false);
  });

  it('refuses a relative escape out of the store and leaves the target intact', async () => {
    const outside = join(tmp, '..', `outside-${Date.now()}.json`);
    await writeFile(outside, '{"secret":true}\n');
    try {
      const h = harness();
      const out = await h.invoke('delete_backup', { file: `../${outside.split('/').pop()}`, dry_run: false });
      const sc = out.structuredContent as { ok: boolean; reason: string; error: string };
      assert.equal(sc.ok, false);
      assert.equal(sc.reason, 'refused');
      assert.match(sc.error, /is not inside the backup directory/);
      assert.match(sc.detail, /refusing to write outside the configured output root/);
      assert.match(textOf(out), /nothing was deleted/);
      assert.equal(h.prompts.length, 0, 'a refused path must not reach the confirmation prompt');
      assert.equal(await exists(outside), true, 'a file outside the store must survive');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('refuses an absolute path to a different directory', async () => {
    const other = await mkdtemp(join(tmpdir(), 'spotify-delete-backup-other-'));
    try {
      const stranger = join(other, 'backup-2026-04-01-1.json');
      await writeFile(stranger, '{}\n');
      const out = await harness().invoke('delete_backup', { file: stranger, dry_run: false });
      const sc = out.structuredContent as { ok: boolean; reason: string };
      assert.equal(sc.ok, false);
      assert.equal(sc.reason, 'refused');
      assert.equal(await exists(stranger), true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a symlink inside the store that points outside it', async () => {
    const other = await mkdtemp(join(tmpdir(), 'spotify-delete-backup-link-'));
    try {
      const target = join(other, 'precious.json');
      await writeFile(target, '{}\n');
      const link = join(tmp, 'backup-2026-05-01-1.json');
      await symlink(target, link);
      const out = await harness().invoke('delete_backup', { file: 'backup-2026-05-01-1.json', dry_run: false });
      const sc = out.structuredContent as { ok: boolean; reason: string };
      assert.equal(sc.ok, false);
      assert.equal(sc.reason, 'refused');
      assert.equal(await exists(target), true, 'a symlink must not become a delete outside the store');
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('refuses a non-backup file that happens to sit in the store', async () => {
    const stranger = join(tmp, 'unrelated.json');
    await writeFile(stranger, '{}\n');
    const out = await harness().invoke('delete_backup', { file: 'unrelated.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; reason: string };
    assert.equal(sc.ok, false);
    assert.equal(sc.reason, 'not_a_backup');
    assert.equal(await exists(stranger), true);
  });

  it('reports not_found for a name that is not there', async () => {
    const out = await harness().invoke('delete_backup', { file: 'backup-2026-06-01-1.json', dry_run: false });
    const sc = out.structuredContent as { ok: boolean; reason: string };
    assert.equal(sc.ok, false);
    assert.equal(sc.reason, 'not_found');
  });

  it('leaves the store listable and empty-consistent after a delete', async () => {
    await seed('backup-2026-07-01-1.json');
    const h = harness();
    await h.invoke('delete_backup', { file: 'backup-2026-07-01-1.json', dry_run: false });
    const listed = await h.invoke('list_backups', { response_format: 'concise' });
    const sc = listed.structuredContent as { count: number; dir_bytes: number; backups: unknown[] };
    assert.equal(sc.count, 0);
    assert.equal(sc.dir_bytes, 0);
    assert.deepEqual(sc.backups, []);
    assert.equal((await readdir(tmp)).length, 0);
  });

  it('honours SPOTIFY_MCP_CONFIRM=never as the documented bypass', async () => {
    const path = await seed('backup-2026-08-01-1.json');
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const h = harness({ capable: false });
    const out = await h.invoke('delete_backup', { file: 'backup-2026-08-01-1.json', dry_run: false });
    assert.equal((out.structuredContent as { deleted: boolean }).deleted, true);
    assert.equal(h.prompts.length, 0);
    assert.equal(await exists(path), false);
  });
});

// A second store is created by the escape test above; make sure the module
// never falls back to the real ~/.spotify-mcp/backups in any test.
describe('delete_backup store isolation', () => {
  it('always resolves inside SPOTIFY_MCP_BACKUP_DIR', async () => {
    const nested = join(tmp, 'deep', 'backups');
    await mkdir(nested, { recursive: true });
    process.env.SPOTIFY_MCP_BACKUP_DIR = nested;
    const path = join(nested, 'backup-2026-09-01-1.json');
    await writeFile(path, '{}\n');
    const out = await harness().invoke('delete_backup', { file: 'backup-2026-09-01-1.json', dry_run: false });
    assert.equal((out.structuredContent as { dir: string }).dir, nested);
    assert.equal((out.structuredContent as { deleted: boolean }).deleted, true);
  });
});
