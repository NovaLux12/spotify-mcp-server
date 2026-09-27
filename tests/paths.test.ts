/**
 * Tests for `src/paths.ts` (#657) — the local-path confinement shared by every
 * export/import tool (#622 write side, #623 read side).
 *
 * The module had no importing test, and it is the sandbox itself: a bug here
 * writes to, or reads from, a path the caller named outside the configured
 * roots. The failure paths it owns:
 *
 *   1. Containment is decided on the REAL path, never the literal string.
 *      `realpath()` collapses `..` and follows every symlink first, so a check
 *      on the raw string is bypassable. The cases below are the three escapes:
 *      an absolute path, a `..` segment, and a symlink planted at a component
 *      inside the root pointing out of it.
 *   2. The write is O_NOFOLLOW, so a symlink swapped in AFTER the check fails
 *      with ELOOP instead of receiving the export.
 *   3. The read side refuses a non-regular file BY NAME. Reading a FIFO or a
 *      /proc entry blocks the serialized request queue forever.
 *   4. Every refusal names the tool, the resolved real path and the roots, so
 *      the caller can act on it.
 *
 * Everything here writes under `mkdtemp(os.tmpdir())`. Nothing reads, writes or
 * deletes anything under a real `~/.spotify-mcp/`; `exportRootDir` is only ever
 * called with a synthetic env in this file.
 *
 * Run: node --import tsx --test tests/paths.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  backupRetentionDays,
  exportRootDir,
  isInsideRoot,
  maxDocumentBytes,
  readInputFile,
  realpathAllowingMissing,
  resolveInputPath,
  resolveOutputPath,
  writeOutputFile,
} from '../src/paths.ts';

let root: string;
let outside: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'x657-paths-'));
  outside = await mkdtemp(path.join(tmpdir(), 'x657-outside-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const TOOL = 'export_playlist';

describe('#657 paths: exportRootDir and the retention default', () => {
  it('honours SPOTIFY_MCP_EXPORT_DIR', () => {
    assert.equal(
      exportRootDir({ SPOTIFY_MCP_EXPORT_DIR: '/tmp/exports' } as NodeJS.ProcessEnv),
      '/tmp/exports',
    );
  });

  it('defaults to <home>/.spotify-mcp/exports without touching the filesystem', () => {
    // `homedir()` reads the OS account, not a synthetic HOME, so this asserts
    // the SHAPE relative to it. exportRootDir only builds a path string — it
    // creates nothing — and nothing in this suite writes under ~/.spotify-mcp.
    const resolved = exportRootDir({} as NodeJS.ProcessEnv);
    assert.equal(resolved, path.join(homedir(), '.spotify-mcp', 'exports'));
    assert.equal(path.basename(resolved), 'exports');
  });

  it('defaults the backup retention to 30 whole days', () => {
    const blank = {} as NodeJS.ProcessEnv;
    assert.equal(backupRetentionDays(blank), 30);
    assert.equal(backupRetentionDays({ SPOTIFY_MCP_BACKUP_RETENTION_DAYS: '' } as NodeJS.ProcessEnv), 30);
  });

  it('treats 0 as "pruning disabled" and floors an enabled window at one day', () => {
    const env = (v: string) => ({ SPOTIFY_MCP_BACKUP_RETENTION_DAYS: v }) as NodeJS.ProcessEnv;
    assert.equal(backupRetentionDays(env('0')), 0, 'zero disables pruning, it is not a one-day window');
    assert.equal(backupRetentionDays(env('1')), 1);
    assert.equal(backupRetentionDays(env('7')), 7);
    assert.equal(backupRetentionDays(env('0.4')), 30, 'a fractional value is unusable, so it falls back');
  });

  it('falls back to the default for anything unusable rather than "keep forever"', () => {
    // A negative, non-numeric or fractional value becoming "keep forever" is
    // the failure this documents: an unbounded store of dated personal data.
    for (const bad of ['-1', 'abc', '1.5', 'NaN', 'Infinity', ' 30 days']) {
      assert.equal(
        backupRetentionDays({ SPOTIFY_MCP_BACKUP_RETENTION_DAYS: bad } as NodeJS.ProcessEnv),
        30,
        `${JSON.stringify(bad)} must fall back to 30, not to unbounded`,
        );
    }
  });
});

describe('#657 paths: maxDocumentBytes', () => {
  it('defaults to 32 MB and floors a configured value to whole MB', () => {
    const blank = {} as NodeJS.ProcessEnv;
    assert.equal(maxDocumentBytes(blank), 32 * 1024 * 1024);
    assert.equal(maxDocumentBytes({ SPOTIFY_MCP_MAX_DOCUMENT_MB: '1' } as NodeJS.ProcessEnv), 1024 * 1024);
    assert.equal(maxDocumentBytes({ SPOTIFY_MCP_MAX_DOCUMENT_MB: '0' } as NodeJS.ProcessEnv), 32 * 1024 * 1024);
    assert.equal(maxDocumentBytes({ SPOTIFY_MCP_MAX_DOCUMENT_MB: '-5' } as NodeJS.ProcessEnv), 32 * 1024 * 1024);
    assert.equal(
      maxDocumentBytes({ SPOTIFY_MCP_MAX_DOCUMENT_MB: 'loud' } as NodeJS.ProcessEnv),
      32 * 1024 * 1024,
      'non-numeric falls back to the default, it does not become an infinite cap',
    );
  });
});

describe('#657 paths: isInsideRoot', () => {
  it('counts the root itself as inside, and a descendant as inside', () => {
    assert.equal(isInsideRoot('/a/b', '/a/b'), true);
    assert.equal(isInsideRoot('/a/b', '/a/b/c'), true);
    assert.equal(isInsideRoot('/a/b', '/a/b/c/d.txt'), true);
  });

  it('refuses a sibling, a parent, and a prefix-sharing sibling', () => {
    // The prefix-sharing sibling is the one a string `startsWith` check admits:
    // `/a/bc` starts with `/a/b` but is not inside it.
    assert.equal(isInsideRoot('/a/b', '/a/bc'), false);
    assert.equal(isInsideRoot('/a/b', '/a'), false);
    assert.equal(isInsideRoot('/a/b', '/x'), false);
  });
});

describe('#657 paths: realpathAllowingMissing', () => {
  it('resolves an existing path to its real location', async () => {
    const dir = path.join(root, 'real');
    await mkdir(dir, { recursive: true });
    assert.equal(await realpathAllowingMissing(dir), await realpath(dir));
  });

  it('resolves a not-yet-created leaf by resolving its deepest existing ancestor', async () => {
    const dir = path.join(root, 'brand-new');
    const target = path.join(dir, 'a', 'b', 'c.txt');
    const resolved = await realpathAllowingMissing(target);
    assert.equal(resolved, path.join(await realpathAllowingMissing(dir), 'a', 'b', 'c.txt'));
    assert.ok(resolved.endsWith(path.join('a', 'b', 'c.txt')), `got ${resolved}`);
  });

  it('collapses a `..` segment in a missing tail', async () => {
    const resolved = await realpathAllowingMissing(path.join(root, 'nope', '..', 'y.txt'));
    assert.equal(resolved, path.join(await realpathAllowingMissing(root), 'y.txt'));
  });
});

describe('#657 paths: resolveOutputPath refuses every escape', () => {
  it('resolves a relative target against the ROOT, not the cwd', async () => {
    // The whole point of the relative case: a cwd-relative path would almost
    // always escape, so `output_dir: "spotify-2026"` must land in the root.
    const out = await resolveOutputPath({ root, target: 'spotify-2026', tool: TOOL, kind: 'directory' });
    assert.equal(out.dir, path.join(await realpathAllowingMissing(root), 'spotify-2026'));
  });

  it('admits an absolute path inside the root', async () => {
    const out = await resolveOutputPath({
      root,
      target: path.join(root, 'nested', 'list.json'),
      tool: TOOL,
      kind: 'file',
    });
    assert.equal(out.file, path.join(await realpathAllowingMissing(root), 'nested', 'list.json'));
    assert.equal(out.dir, path.join(await realpathAllowingMissing(root), 'nested'));
  });

  it('refuses an absolute path outside the root', async () => {
    await assert.rejects(
      () => resolveOutputPath({ root, target: path.join(outside, 'escaped.json'), tool: TOOL, kind: 'file' }),
      (err: Error) => {
        assert.match(err.message, /refusing to write outside the configured output root/);
        assert.match(err.message, new RegExp(`not inside ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
        assert.match(err.message, /SPOTIFY_MCP_EXPORT_DIR/, 'the refusal names what to configure');
        return true;
      },
    );
  });

  it('refuses a `..` segment that climbs out of the root', async () => {
    await assert.rejects(
      () => resolveOutputPath({ root, target: '../escaped.json', tool: TOOL, kind: 'file' }),
      /refusing to write outside the configured output root/,
    );
  });

  it('refuses a `..` segment buried mid-path, not just at the front', async () => {
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'a/b/../../../escaped.json', tool: TOOL, kind: 'file' }),
      /refusing to write outside the configured output root/,
    );
  });

  it('refuses a SYMLINK inside the root that points out of it', async () => {
    // The case a literal-string containment check admits and a realpath check
    // does not: every component of the path is inside the root, and the last
    // one is a link to a directory outside it.
    const link = path.join(root, 'escape-link');
    await symlink(outside, link, 'dir');
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'escape-link/pwn.json', tool: TOOL, kind: 'file' }),
      /refusing to write outside the configured output root/,
    );
  });

  it('refuses a symlinked component in the MIDDLE of the path', async () => {
    const mid = path.join(root, 'mid-link');
    await symlink(outside, mid, 'dir');
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'mid-link/deep/pwn.json', tool: TOOL, kind: 'file' }),
      /refusing to write outside the configured output root/,
    );
  });

  it('refuses to name the output ROOT as a file destination', async () => {
    // `isInsideRoot` counts the root as inside; the writer is what rejects it.
    assert.equal(isInsideRoot(root, root), true, 'precondition: containment admits the root itself');
    await assert.rejects(
      () => resolveOutputPath({ root, target: '.', tool: TOOL, kind: 'file' }),
      /must name a file inside .*, not the output root itself/,
    );
  });
});

describe('#657 paths: resolveOutputPath refuses a destructive overwrite', () => {
  it('refuses to overwrite an existing file by default', async () => {
    const existing = path.join(root, 'taken.json');
    await writeFile(existing, 'original', 'utf8');
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'taken.json', tool: TOOL, kind: 'file' }),
      /refusing to overwrite the existing file/,
    );
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'taken.json', tool: TOOL, kind: 'file' }),
      /overwrite: true/,
      'the refusal names the escape hatch',
    );
  });

  it('admits the overwrite when the caller asked for it', async () => {
    const existing = path.join(root, 'replaceable.json');
    await writeFile(existing, 'original', 'utf8');
    const out = await resolveOutputPath({
      root, target: 'replaceable.json', tool: TOOL, kind: 'file', overwrite: true,
    });
    assert.equal(out.file, path.join(await realpathAllowingMissing(root), 'replaceable.json'));
  });

  it('refuses to write to an existing DIRECTORY, even with overwrite: true', async () => {
    await mkdir(path.join(root, 'a-dir'), { recursive: true });
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'a-dir', tool: TOOL, kind: 'file', overwrite: true }),
      /it is an existing directory/,
    );
  });

  it('refuses to use a FILE as an output directory', async () => {
    await writeFile(path.join(root, 'not-a-dir'), 'x', 'utf8');
    await assert.rejects(
      () => resolveOutputPath({ root, target: 'not-a-dir', tool: TOOL, kind: 'directory' }),
      /it exists and is not a directory/,
    );
  });

  it('creates the output directory at mode 0700', async () => {
    const out = await resolveOutputPath({ root, target: 'mode-check', tool: TOOL, kind: 'directory' });
    const stats = await lstat(out.dir);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.mode & 0o777, 0o700, `exports are user-only, got ${(stats.mode & 0o777).toString(8)}`);
  });

  it('names the tool that refused, so the caller knows who refused', async () => {
    await assert.rejects(
      () => resolveOutputPath({ root, target: '../x.json', tool: 'export_profile_state', kind: 'file' }),
      /^Error: export_profile_state: refusing/,
    );
  });
});

describe('#657 paths: writeOutputFile', () => {
  it('writes the data through, at mode 0600', async () => {
    const out = await resolveOutputPath({ root, target: 'export.json', tool: TOOL, kind: 'file' });
    await writeOutputFile(out.file, '{"ok":true}');
    assert.equal(await readFile(out.file, 'utf8'), '{"ok":true}');
    const stats = await lstat(out.file);
    assert.equal(stats.mode & 0o777, 0o600, `an export is user-only, got ${(stats.mode & 0o777).toString(8)}`);
  });

  it('refuses to write THROUGH a symlink, failing with ELOOP', async () => {
    // The TOCTOU gap: a link swapped in after resolveOutputPath's check must
    // not receive the export. O_NOFOLLOW is what closes it.
    const target = path.join(root, 'symlink-target.txt');
    await writeFile(target, 'untouched', 'utf8');
    const link = path.join(root, 'link.txt');
    await symlink(target, link, 'file');

    await assert.rejects(
      () => writeOutputFile(link, 'exfiltrated'),
      (err: NodeJS.ErrnoException) => {
        assert.equal(err.code, 'ELOOP', `expected ELOOP from O_NOFOLLOW, got ${err.code}`);
        return true;
      },
    );
    assert.equal(await readFile(target, 'utf8'), 'untouched', 'the symlink target must be unmodified');
  });

  it('truncates an existing file rather than appending to it', async () => {
    const file = path.join(root, 'truncate.txt');
    await writeFile(file, 'a much longer original body', 'utf8');
    await writeOutputFile(file, 'short');
    assert.equal(await readFile(file, 'utf8'), 'short');
  });
});

describe('#657 paths: resolveInputPath refuses every read escape', () => {
  it('refuses when NO read roots are configured, naming the target', async () => {
    // Fail-closed: with no roots, nothing is readable. Defaulting to the cwd
    // or the home directory would make the sandbox opt-out.
    await assert.rejects(
      () => resolveInputPath({ roots: [], tool: 'import_profile_state', target: 'x.json' }),
      /no allowed read roots are configured/,
    );
  });

  it('refuses a path outside every root and lists the roots', async () => {
    const file = path.join(outside, 'not-mine.json');
    await writeFile(file, '{}', 'utf8');
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file }),
      (err: Error) => {
        assert.match(err.message, /refusing to read outside the allowed read roots/);
        assert.match(err.message, /Allowed read roots:/);
        return true;
      },
    );
  });

  it('refuses a `..` traversal out of a root', async () => {
    // Every component of the named path is a real, readable file; only the
    // `..` leaves the root. A literal-string containment check admits it.
    const file = path.join(outside, 'traverse.json');
    await writeFile(file, '{}', 'utf8');
    await assert.rejects(
      () => resolveInputPath({
        roots: [root],
        tool: 'import_profile_state',
        target: path.join(root, '..', path.basename(outside), 'traverse.json'),
      }),
      /refusing to read outside the allowed read roots/,
    );
  });

  it('refuses a symlink inside a root that points out of it', async () => {
    const file = path.join(outside, 'linked.json');
    await writeFile(file, '{"secret":true}', 'utf8');
    const link = path.join(root, 'escape-read.json');
    await symlink(file, link, 'file');
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: link }),
      /refusing to read outside the allowed read roots/,
    );
  });

  it('admits a regular file inside any one of several roots', async () => {
    const other = path.join(root, 'second-root');
    await mkdir(other, { recursive: true });
    const file = path.join(other, 'ok.json');
    await writeFile(file, '{}', 'utf8');
    const out = await resolveInputPath({ roots: [path.join(root, 'first-root'), other], tool: 'import_profile_state', target: file });
    assert.equal(out.path, await realpathAllowingMissing(file));
  });

  it('reports a missing file with the allowed roots, not a bare ENOENT', async () => {
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: path.join(root, 'absent.json') }),
      (err: Error) => {
        assert.match(err.message, /no readable file at/);
        assert.match(err.message, /Allowed read roots:/);
        return true;
      },
    );
  });

  it('appends the env hint so the operator knows what to configure', async () => {
    await assert.rejects(
      () => resolveInputPath({
        roots: [root],
        tool: 'import_profile_state',
        target: path.join(root, 'absent.json'),
        envHint: 'Set SPOTIFY_MCP_PORTABILITY_DIR.',
      }),
      /Set SPOTIFY_MCP_PORTABILITY_DIR\./,
    );
  });

  it('refuses a DIRECTORY by name rather than opening it', async () => {
    await mkdir(path.join(root, 'a-read-dir'), { recursive: true });
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: path.join(root, 'a-read-dir') }),
      /is a directory, not a regular file/,
    );
  });

  it('refuses a FIFO by name, because opening one blocks the request queue forever', async () => {
    // The documented reason this check exists at all. Without it the read
    // never returns, and the serialized request queue stops serving.
    const fifo = path.join(root, 'pipe');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('mkfifo', [fifo]);
    const stats = await lstat(fifo);
    assert.equal(stats.isFile(), false, 'precondition: a FIFO is not a regular file');
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: fifo }),
      /is a FIFO, not a regular file/,
    );
  });

  it('refuses a file over the size cap, naming the size and the limit', async () => {
    const big = path.join(root, 'big.json');
    await writeFile(big, 'x'.repeat(4096), 'utf8');
    await assert.rejects(
      () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: big, maxBytes: 1024 }),
      (err: Error) => {
        assert.match(err.message, /refusing to read 4096 bytes/);
        assert.match(err.message, /over the 1024-byte document limit/);
        return true;
      },
    );
  });

  it('admits a file exactly at the cap', async () => {
    const exact = path.join(root, 'exact.json');
    await writeFile(exact, 'x'.repeat(1024), 'utf8');
    const out = await resolveInputPath({ roots: [root], tool: 'import_profile_state', target: exact, maxBytes: 1024 });
    assert.equal(out.bytes, 1024);
    assert.equal(out.maxBytes, 1024, 'the admission reports the ceiling it was admitted under');
  });

  it('reports the stat()-time size and the ceiling it used', async () => {
    const file = path.join(root, 'sized.json');
    await writeFile(file, 'abc', 'utf8');
    const out = await resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file, maxBytes: 512 });
    assert.equal(out.bytes, 3);
    assert.equal(out.maxBytes, 512);
  });
});

describe('#657 paths: readInputFile', () => {
  it('reads the file back verbatim', async () => {
    const file = path.join(root, 'read-me.json');
    await writeFile(file, '{"a":1}', 'utf8');
    const input = await resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file, maxBytes: 1024 });
    assert.equal(await readInputFile(input, 'import_profile_state'), '{"a":1}');
  });

  it('re-checks the BYTES ACTUALLY READ, so a file that grew after stat() is refused', async () => {
    // The gap the re-check closes: the cap was enforced against a stat() that a
    // concurrent writer can invalidate. Asserting only the stat()-time size
    // would pass while an attacker swapped in a 200 MB body.
    const file = path.join(root, 'grow.json');
    await writeFile(file, 'small', 'utf8');
    const input = await resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file, maxBytes: 1024 });
    assert.equal(input.bytes, 5, 'precondition: admitted on a 5-byte stat()');
    await writeFile(file, 'x'.repeat(4096), 'utf8');
    await assert.rejects(
      () => readInputFile(input, 'import_profile_state'),
      (err: Error) => {
        assert.match(err.message, /refused to parse 4096 bytes read/);
        assert.match(err.message, /over the 1024-byte document limit/);
        return true;
      },
    );
  });

  it('measures UTF-8 bytes, not code units', async () => {
    // A multi-byte document measured in characters passes a byte cap it fails.
    const file = path.join(root, 'utf8.json');
    await writeFile(file, 'é'.repeat(64), 'utf8');
    const input = await resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file, maxBytes: 1000 });
    assert.equal(input.bytes, 128);
    assert.equal((await readInputFile(input)).length, 64, 'the string is 64 chars but 128 bytes');
  });

  it('refuses to read THROUGH a symlink, failing with ELOOP', async () => {
    const target = path.join(root, 'nofollow-target.txt');
    await writeFile(target, 'untouched', 'utf8');
    const link = path.join(root, 'nofollow-link.txt');
    await symlink(target, link, 'file');
    await assert.rejects(
      () => readInputFile({ path: link, bytes: 9, maxBytes: 1024 }, 'import_profile_state'),
      (err: NodeJS.ErrnoException) => err.code === 'ELOOP',
    );
    assert.equal(await readFile(target, 'utf8'), 'untouched');
  });
});

// The errno branch: an unreadable DIRECTORY, so realpath() itself fails
// EACCES. (A 0o000 *file* would not exercise it — stat/lstat do not need read
// permission on the file, only execute on its parent.)
describe('#657 paths: resolveInputPath surfaces a permission failure by code', () => {
  it('names the errno rather than collapsing it into "no readable file"', async function () {
    if (process.getuid?.() === 0) {
      // root ignores the permission bits, so there is nothing to assert.
      return;
    }
    const dir = path.join(root, 'unreadable-dir');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'secret.json');
    await writeFile(file, '{}', 'utf8');
    await chmod(dir, 0o000);
    try {
      await assert.rejects(
        () => resolveInputPath({ roots: [root], tool: 'import_profile_state', target: file }),
        (err: Error) => {
          assert.match(err.message, /cannot read/);
          assert.match(err.message, /EACCES/, 'the errno is named, so the cause is diagnosable');
          return true;
        },
      );
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
