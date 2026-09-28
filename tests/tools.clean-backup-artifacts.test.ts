/**
 * Tests for `clean_backup_artifacts` (#1592).
 *
 * The tool exists because four writers share `SPOTIFY_MCP_BACKUP_DIR` and
 * only one of them was reachable through the tools, so nearly every path
 * here is about what it REFUSES: it must not touch a library backup, must
 * not delete a file it cannot name, must not follow a symlink out of the
 * store, must not commit without a human, and must not commit at all by
 * default. The one positive path — an actual deletion — is asserted
 * against the directory listing rather than against a return value,
 * because the listing is the thing the caller cannot argue with.
 *
 * Real tmpdir store; no Spotify calls are made or expected.
 */
import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerBackupCleanupTools } from '../src/tools/backup_cleanup.js';
import { registerBackupDeleteTools } from '../src/tools/backup_delete.js';
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
 * A server double that advertises elicitation and answers the prompt, so the
 * gate is exercised for real rather than bypassed with
 * SPOTIFY_MCP_CONFIRM=never. `capable: false` models a host that cannot
 * prompt at all, which the gate must refuse rather than treat as consent.
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
  const noSpotify = {
    calls: [],
    async get<T>(): Promise<T | null> {
      throw new Error('clean_backup_artifacts must not call Spotify');
    },
  } as unknown as SpotifyClient;
  // All three manifest rows (#1592). Registering only the tool under test
  // would make the cross-tool assertions vacuous: the point of the library
  // refusals is that `delete_backup` still owns those files, and the
  // `dir_bytes` comparison is only meaningful if `list_backups` is really
  // registered and really disagrees about scope.
  registerBackupCleanupTools(fakeServer, noSpotify);
  registerBackupDeleteTools(fakeServer, noSpotify);
  registerBackupTools(fakeServer, noSpotify);
  return {
    prompts,
    registered,
    invoke: async (name: string, args: Record<string, unknown>) => {
      const tool = registered.find((t) => t.name === name);
      assert.ok(tool, `tool "${name}" should be registered`);
      return tool.handler(tool.validate(args));
    },
  };
}

const textOf = (out: { content: Array<{ text: string }> }) => out.content[0]!.text;
const payloadOf = (out: { structuredContent?: Record<string, unknown> }) => out.structuredContent ?? {};

let tmp: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'spotify-clean-artifacts-'));
  savedEnv = {
    SPOTIFY_MCP_BACKUP_DIR: process.env.SPOTIFY_MCP_BACKUP_DIR,
    SPOTIFY_MCP_CONFIRM: process.env.SPOTIFY_MCP_CONFIRM,
    SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS: process.env.SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS,
  };
  process.env.SPOTIFY_MCP_BACKUP_DIR = tmp;
  delete process.env.SPOTIFY_MCP_CONFIRM;
  delete process.env.SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DAY_MS = 86_400_000;

/** A library snapshot plus the `.meta.json` sidecar `backup_library` writes. */
async function seedLibraryBackup(name: string): Promise<string> {
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

/** A non-library artifact, aged `days` old by mtime. */
async function seedArtifact(name: string, days = 30, body = '{"id":"x"}'): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, `${body}\n`, { mode: 0o600 });
  if (days > 0) {
    const when = new Date(Date.now() - days * DAY_MS);
    await utimes(path, when, when);
  }
  return path;
}

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const names = async (): Promise<string[]> => (await readdir(tmp)).sort();

describe('clean_backup_artifacts (#1592)', () => {
  it('previews by default and deletes nothing', async () => {
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', {});
    assert.equal(payloadOf(out).dry_run, true, 'an omitted dry_run must preview');
    assert.equal(payloadOf(out).selected, 1);
    assert.equal(await exists(session), true, 'a preview must not unlink anything');
    assert.deepEqual(h.prompts, [], 'a preview must not prompt');
  });

  it('publishes dry_run default true in the schema, not just in the handler', () => {
    // The handler branches on isDryRun(args), so an omitted flag previews even
    // for a hand-built args object. This asserts the OTHER half: a host that
    // only reads tools/list must also see it, which is what #827 was about.
    const registered: Array<{ name: string; schema: z.ZodRawShape }> = [];
    const fakeServer = {
      tool(name: string, _d: string, schema: z.ZodRawShape) {
        registered.push({ name, schema });
      },
    } as unknown as McpServer;
    registerBackupCleanupTools(fakeServer, {} as SpotifyClient);
    const tool = registered.find((t) => t.name === 'clean_backup_artifacts');
    assert.ok(tool, 'clean_backup_artifacts should be registered');
    const parsed = z.object(tool.schema).parse({});
    assert.equal(parsed.dry_run, true, 'the published schema must carry default true');
  });

  it('deletes an aged artifact on dry_run:false after an accepted prompt', async () => {
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.equal(payloadOf(out).deleted, 1);
    assert.equal(await exists(session), false, 'an accepted prompt must unlink the artifact');
    assert.equal(h.prompts.length, 1, 'executing must prompt exactly once');
  });

  it('refuses to execute when the client cannot prompt, and deletes nothing', async () => {
    // The fail-closed half. `unsupported` is a refusal, never a consent: a
    // host that never advertised elicitation must not be able to make a
    // destructive call succeed by being incapable.
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness({ capable: false });
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.notEqual(payloadOf(out).ok, true);
    assert.equal(await exists(session), true, 'an incapable client must not unlink anything');
  });

  it('refuses when the prompt is declined, and deletes nothing', async () => {
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness({ answer: { action: 'decline' } });
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.notEqual(payloadOf(out).ok, true);
    assert.equal(await exists(session), true, 'a declined prompt must unlink nothing');
  });

  it('asks even for a single file, because its sibling does', async () => {
    // delete_backup prompts for ONE file. A threshold here would make the
    // bulk case the easy path and the single deliberate cleanup the
    // annoying one, which is backwards.
    await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0, family: 'sessions' });
    assert.equal(h.prompts.length, 1, 'one file must still prompt');
  });

  it('never touches a library backup or its sidecar during a sweep', async () => {
    const snapshot = await seedLibraryBackup('backup-2026-01-02-1.json');
    const sidecar = join(tmp, 'backup-2026-01-02-1.meta.json');
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
    assert.equal(await exists(snapshot), true, 'a library backup must survive an every-family sweep');
    assert.equal(await exists(sidecar), true, 'its sidecar must survive with it');
    assert.equal(await exists(session), false, 'the artifact in scope must go');
    assert.equal(payloadOf(out).library_backup_count, 1);
    assert.equal(payloadOf(out).library_sidecar_count, 1);
  });

  it('refuses a library backup named directly, and points at delete_backup', async () => {
    const snapshot = await seedLibraryBackup('backup-2026-01-02-1.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { files: ['backup-2026-01-02-1.json'], dry_run: false });
    assert.equal(payloadOf(out).reason, 'is_a_library_backup');
    assert.equal(payloadOf(out).use, 'delete_backup');
    assert.equal(await exists(snapshot), true, 'the refusal must not unlink anything');
    assert.deepEqual(h.prompts, [], 'a refusal must not reach the prompt');
  });

  it('refuses a sidecar named directly, for the same reason', async () => {
    // The sidecar does not match BACKUP_FILE_RE, so without an explicit rule
    // it would classify as unrecognised rather than as what it is. Either
    // way it must survive: it belongs to a library snapshot.
    await seedLibraryBackup('backup-2026-01-02-1.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { files: ['backup-2026-01-02-1.meta.json'], dry_run: false });
    assert.equal(payloadOf(out).reason, 'is_a_library_backup');
    assert.equal(await exists(join(tmp, 'backup-2026-01-02-1.meta.json')), true);
  });

  it('delete_backup still owns library backups after this tool exists', async () => {
    // The cross-tool assertion the two-registrars harness exists for: the
    // sibling must not have been widened, and must still refuse the
    // non-library families by name.
    const h = harness();
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const refused = await h.invoke('delete_backup', { file: 'listening-session-2026-01-01.json' });
    assert.equal(payloadOf(refused).reason, 'not_a_backup', 'delete_backup must still refuse an artifact');
    assert.equal(await exists(session), true);

    const snapshot = await seedLibraryBackup('backup-2026-01-02-1.json');
    const ok = await h.invoke('delete_backup', { file: 'backup-2026-01-02-1.json', dry_run: false });
    assert.equal(payloadOf(ok).deleted, true, 'delete_backup must still work on its own family');
    assert.equal(await exists(snapshot), false);
  });

  it('leaves a file it cannot name alone and reports it', async () => {
    const mystery = await seedArtifact('notes-from-a-future-release.json');
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
    assert.equal(await exists(mystery), true, 'an unrecognised file must never be deleted');
    assert.ok((payloadOf(out).unrecognised as string[]).includes('notes-from-a-future-release.json'));
    assert.equal(await exists(session), false);
  });

  it('refuses a named file outside the backup directory', async () => {
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { files: ['../escape.json'], dry_run: false });
    assert.equal(payloadOf(out).reason, 'refused');
    assert.deepEqual(h.prompts, []);
  });

  it('refuses a named file that is not a cleanup target', async () => {
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { files: ['random-notes.json'], dry_run: false });
    assert.equal(payloadOf(out).reason, 'not_a_cleanup_target');
  });

  it('never follows a symlink planted under a family name', async () => {
    // lstat, not stat: the link's target is outside the store, and unlinking
    // the LINK would still be a deletion the tool cannot describe. This is
    // the readStoreEntry regularFile rule (#623) applied to deletion.
    const outside = join(tmp, '..', `outside-target-${process.pid}.json`);
    await writeFile(outside, '{"secret":true}\n', { mode: 0o600 });
    try {
      await symlink(outside, join(tmp, 'listening-session-planted.json'));
      const h = harness();
      const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
      assert.ok(
        (payloadOf(out).not_regular as string[]).includes('listening-session-planted.json'),
        'a symlink must be reported as not_regular, never as a candidate',
      );
      assert.equal(await exists(outside), true, 'the symlink target must be untouched');
    } finally {
      await rm(outside, { force: true });
    }
  });

  it('keeps artifacts younger than the window and expires the rest', async () => {
    const old = await seedArtifact('listening-session-old.json', 30);
    const fresh = await seedArtifact('listening-session-fresh.json', 1);
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.equal(await exists(old), false, 'a 30-day-old artifact is past the 14-day default');
    assert.equal(await exists(fresh), true, 'a 1-day-old artifact is inside the 14-day default');
    assert.equal(payloadOf(out).retention_days, 14, 'the default window must be reported, not inferred');
    assert.equal(payloadOf(out).retention_source, 'SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS');
  });

  it('reads its own window, not the library one', async () => {
    // The two variables are separate by contract; setting only the library
    // window must not move this tool's selection.
    process.env.SPOTIFY_MCP_BACKUP_RETENTION_DAYS = '0';
    const artifact = await seedArtifact('listening-session-x.json', 30);
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', {});
    assert.equal(payloadOf(out).retention_days, 14, 'the library window must not leak in');
    assert.ok((payloadOf(out).selected as number) >= 1, 'the aged artifact should be selected');
    assert.equal(await exists(artifact), true, 'this is a preview');
  });

  it('honours 0 as "disable age-based expiry" rather than "delete everything"', async () => {
    // 0 disables the window, so a bare sweep selects nothing; deleting
    // everything is what `older_than_days: 0` asks for explicitly.
    process.env.SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS = '0';
    const session = await seedArtifact('listening-session-2026-01-01.json', 0);
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.equal(payloadOf(out).selected, 0);
    assert.equal(await exists(session), true);

    const out2 = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
    assert.equal(await exists(session), false, 'an explicit older_than_days:0 is the opt-out from the window');
  });

  it('older_than_days:0 selects every family regardless of age', async () => {
    await seedArtifact('listening-session-a.json', 0);
    await seedArtifact('playlistops-pre-37-2026.json', 0);
    await seedArtifact('playback-bookmark-abc.json', 0);
    await seedArtifact('playback-bookmark-abc.json.migrated', 0);
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
    assert.equal(payloadOf(out).selected, 4, 'all four non-library families are reachable');
    assert.deepEqual(await names(), []);
  });

  it('family narrows the sweep', async () => {
    await seedArtifact('listening-session-a.json', 30);
    const pre = await seedArtifact('playlistops-pre-37-2026.json', 30);
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0, family: 'sessions' });
    assert.equal(payloadOf(out).selected, 1);
    assert.equal(await exists(pre), true, 'a different family must be left alone');
  });

  it('names the file it is deleting, so the prompt is not a bare count', async () => {
    await seedArtifact('listening-session-2026-01-01.json');
    const h = harness();
    await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.match(h.prompts[0] ?? '', /listening-session-2026-01-01\.json/);
  });

  it('reports directory_bytes as a real measurement, and says it differs from dir_bytes', async () => {
    // The honesty half of #1592. storeEnvelope's dir_bytes sums library
    // entries only, so it cannot answer "how big is this directory". The
    // tool must publish a genuinely measured whole-directory figure AND say
    // in words that the two are not the same number — a bare second field
    // would read as a correction nobody asked for.
    const snapshot = await seedLibraryBackup('backup-2026-01-02-1.json');
    const sidecar = join(tmp, 'backup-2026-01-02-1.meta.json');
    const session = await seedArtifact('listening-session-2026-01-01.json', 0, '{"pad":"yyyyyyyyyyyyyyyyyyyyyyyy"}');
    const listed = await harness().invoke('list_backups', {});
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { older_than_days: 0 });

    const libraryBytes = payloadOf(listed).dir_bytes as number;
    const directoryBytes = payloadOf(out).directory_bytes as number;
    const libraryPart = payloadOf(out).library_backup_bytes as number;
    const artifactBytes = (await stat(session)).size;

    assert.ok(
      Number.isFinite(directoryBytes) && directoryBytes > 0,
      'directory_bytes must be a measured positive number, not null or 0',
    );
    // The two published halves must reconstruct the whole, and the library
    // half must itself be the snapshot plus its sidecar. Derived from what
    // is on disk rather than from the tool's own fields, so it fails if the
    // tool restates its input instead of measuring.
    assert.equal(
      libraryPart,
      (await stat(snapshot)).size + (await stat(sidecar)).size,
      'library_backup_bytes must be the snapshot plus its sidecar',
    );
    assert.equal(
      directoryBytes,
      libraryPart + artifactBytes,
      'directory_bytes must be the sum of every regular file in the directory',
    );
    assert.ok(
      directoryBytes > libraryBytes,
      'the whole-directory measurement must exceed the library-only envelope here',
    );
    assert.match(
      payloadOf(out).dir_bytes_caveat as string,
      /library-backup files and their sidecars alone/,
      'the caveat must name what dir_bytes actually counts',
    );
  });

  it('library_backup_bytes agrees with list_backups rather than restating it', async () => {
    // Both figures come from the same storeEnvelope call, so the two tools
    // cannot drift. This is what makes reporting both honest rather than
    // two independently-computed numbers that happen to look similar.
    await seedLibraryBackup('backup-2026-01-02-1.json');
    await seedArtifact('listening-session-2026-01-01.json', 0);
    const listed = await harness().invoke('list_backups', {});
    const out = await harness().invoke('clean_backup_artifacts', { older_than_days: 0 });
    assert.equal(payloadOf(out).library_backup_bytes, payloadOf(listed).dir_bytes);
  });

  it('a committed run re-measures the directory afterwards', async () => {
    await seedArtifact('listening-session-a.json', 0, '{"pad":"yyyyyyyyyyyyyyyyyyyyyyyy"}');
    await seedLibraryBackup('backup-2026-01-02-1.json');
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false, older_than_days: 0 });
    const after = payloadOf(out).directory_bytes_after as number;
    const snapshotBytes = (await stat(join(tmp, 'backup-2026-01-02-1.json'))).size;
    assert.ok(after > 0, 'a post-delete measurement must still report the survivors');
    assert.ok(after <= snapshotBytes + 4096, 'the deleted artifact must not be counted after the fact');
  });

  it('SPOTIFY_MCP_CONFIRM=never bypasses the prompt but not the preview default', async () => {
    // The only sanctioned bypass, and it removes the prompt — never the
    // preview. A bypass that also removed the default would be a silent
    // destructive tool wearing an automation flag.
    process.env.SPOTIFY_MCP_CONFIRM = 'never';
    const session = await seedArtifact('listening-session-2026-01-01.json');
    const h = harness({ capable: false });

    const preview = await h.invoke('clean_backup_artifacts', {});
    assert.equal(payloadOf(preview).dry_run, true, 'the preview default survives the bypass');
    assert.equal(await exists(session), true);

    const committed = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.equal(await exists(session), false, 'with the bypass set, dry_run:false commits');
  });

  it('an unparseable window falls back to the default rather than to "keep forever"', async () => {
    // Same rule as backupRetentionDays: a typo should expire data.
    for (const raw of ['', 'abc', '-1', '2.5']) {
      process.env.SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS = raw;
      const out = await harness().invoke('clean_backup_artifacts', {});
      assert.equal(payloadOf(out).retention_days, 14, `"${raw}" should fall back to the default`);
    }
    process.env.SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS = '0';
    const off = await harness().invoke('clean_backup_artifacts', {});
    assert.equal(payloadOf(off).retention_days, 0, 'an explicit 0 is honoured as written');
  });

  it('an empty directory is a no-op, not an error', async () => {
    const h = harness();
    const out = await h.invoke('clean_backup_artifacts', { dry_run: false });
    assert.equal(payloadOf(out).selected, 0);
    assert.equal(payloadOf(out).deleted, 0);
    assert.equal(payloadOf(out).directory_bytes, 0);
  });
});
