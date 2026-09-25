/**
 * Local-path confinement for export/import tools (#622).
 *
 * Every tool that takes a caller-supplied local destination resolves it
 * through `resolveOutputPath` before touching the disk, so a write can never
 * leave the configured output root — whether the escape arrives as an absolute
 * path, a `..` segment, or a symlink planted at any component.
 *
 * Containment is decided on the REAL path, never on the literal string:
 * realpath() collapses `..` and follows every symlink first, so a check that
 * ran on the raw string would be bypassable (that is the bug this replaces).
 * The final write additionally uses O_NOFOLLOW so a symlink swapped in after
 * the check fails with ELOOP instead of receiving the export.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Output root for tools that have no directory of their own
 * (export_playlist, export_profile_state).
 * NEW ENV VAR SPOTIFY_MCP_EXPORT_DIR — default ~/.spotify-mcp/exports.
 */
export function exportRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SPOTIFY_MCP_EXPORT_DIR ?? join(homedir(), '.spotify-mcp', 'exports');
}

/**
 * realpath() that tolerates a not-yet-created leaf: the deepest existing
 * ancestor is resolved and the missing tail re-attached, so a brand-new
 * directory is still compared by its real location. Any other errno (EACCES,
 * ELOOP) propagates instead of silently passing an unresolved path.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      // Reached the filesystem root: realpath() always succeeds there.
      if (parent === current) return join(await realpath(current), ...missing);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export interface ResolveOutputBase {
  /** Configured output root; nothing outside it may be written. */
  root: string;
  /** Caller destination: absolute, or interpreted relative to `root`. */
  target: string;
  /** Tool name, quoted in every refusal so the caller knows who refused. */
  tool: string;
  /**
   * Required to replace an existing file. Off by default: an export never
   * silently destroys a file the caller did not name as replaceable.
   */
  overwrite?: boolean;
}

export interface ResolveOutputOptions extends ResolveOutputBase {
  kind: 'file' | 'directory';
}

/** Resolved destination for a directory: the directory to write into. */
export interface ResolvedDirectory {
  /** Absolute, symlink-resolved directory the tool may write into. */
  readonly dir: string;
}

/** Resolved destination for a file: its parent, plus the file itself. */
export interface ResolvedFile extends ResolvedDirectory {
  /** Absolute, symlink-resolved file path. */
  readonly file: string;
}

/**
 * Resolve a caller-supplied destination and refuse anything that leaves the
 * root. Relative targets are interpreted against the root, so `output_dir:
 * "spotify-2026"` means `<root>/spotify-2026` rather than a cwd-relative path
 * that would almost always escape.
 */
export function resolveOutputPath(
  options: ResolveOutputBase & { kind: 'directory' },
): Promise<ResolvedDirectory>;
export function resolveOutputPath(
  options: ResolveOutputBase & { kind: 'file' },
): Promise<ResolvedFile>;
export async function resolveOutputPath(
  options: ResolveOutputOptions,
): Promise<ResolvedDirectory | ResolvedFile> {
  const { root, target, tool, kind, overwrite = false } = options;
  const rootReal = await realpathAllowingMissing(resolve(root));
  const requested = isAbsolute(target) ? resolve(target) : resolve(rootReal, target);
  const real = await realpathAllowingMissing(requested);

  const rel = relative(rootReal, real);
  const inside = rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) {
    throw new Error(
      `${tool}: refusing to write outside the configured output root — "${target}" resolves to ` +
        `${real}, which is not inside ${rootReal}. Set SPOTIFY_MCP_EXPORT_DIR / ` +
        'SPOTIFY_MCP_PORTABILITY_DIR to the directory you want exports written to.',
    );
  }

  // Existence and type are read from the path the CALLER named; writes go to
  // the real path, so a symlink named at the destination is judged by its
  // target, not by the link itself.
  const existing = await lstat(requested).catch(() => null);

  if (kind === 'directory') {
    if (existing && !existing.isDirectory()) {
      throw new Error(
        `${tool}: refusing to use "${target}" as an output directory — it exists and is not a directory.`,
      );
    }
    await mkdir(real, { recursive: true, mode: 0o700 });
    return { dir: real };
  }

  if (rel === '') {
    throw new Error(
      `${tool}: output_path must name a file inside ${rootReal}, not the output root itself.`,
    );
  }
  if (existing?.isDirectory()) {
    throw new Error(`${tool}: refusing to write to "${target}" — it is an existing directory.`);
  }
  if (existing && !overwrite) {
    throw new Error(
      `${tool}: refusing to overwrite the existing file ${real}. ` +
        'Re-run with overwrite: true to replace it.',
    );
  }
  return { dir: dirname(real), file: real };
}

/** Write a confined export file: mode 0600, never through a symlink. */
export async function writeOutputFile(file: string, data: string): Promise<void> {
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(data, 'utf8');
  } finally {
    await handle.close();
  }
}
