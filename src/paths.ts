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

  const inside = isInsideRoot(rootReal, real);
  // rel === '' means the caller named the output root itself, rejected below.
  const rel = relative(rootReal, real);
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

/**
 * THE definition of "inside the root", shared by the write side above and the
 * read side below: two implementations of containment could disagree about a
 * borderline path, and the weaker one silently widens the sandbox. Both sides
 * pass REAL (realpath()-resolved) paths.
 *
 * A path equal to the root counts as inside. Neither side lets it through on
 * its own: the writer rejects naming the root as a file destination, and the
 * reader's regular-file check reports the real reason.
 */
function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Read side (#623) — added by V5Import. Everything below is additive: the
// write-side helpers above are untouched.
// ---------------------------------------------------------------------------

/** Default ceiling on a document a tool will pull into memory: 32 MB. */
export const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * NEW ENV VAR SPOTIFY_MCP_MAX_DOCUMENT_MB — per-document read ceiling in MB
 * (default 32, i.e. DEFAULT_MAX_DOCUMENT_BYTES). Documents are stat()ed
 * against this BEFORE they are read, so a multi-hundred-MB file is refused
 * instead of buffered and parsed.
 */
export function maxDocumentBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.SPOTIFY_MCP_MAX_DOCUMENT_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_DOCUMENT_BYTES / (1024 * 1024);
  return mb * 1024 * 1024;
}

export interface ResolveInputOptions {
  /** Every directory a read may come from; anything else is refused. */
  roots: readonly string[];
  /** Tool name, quoted in every refusal so the caller knows who refused. */
  tool: string;
  /** Caller path: absolute, `~`-prefixed, or relative to the process cwd. */
  target: string;
  /** Byte ceiling; defaults to maxDocumentBytes(). */
  maxBytes?: number;
  /** Named in the refusal so the operator knows what to configure. */
  envHint?: string;
}

export interface ResolvedInput {
  /** Absolute, symlink-resolved path of a regular file inside a root. */
  path: string;
  /** Size the file had at stat() time. */
  bytes: number;
  /** The ceiling this path was admitted under. */
  maxBytes: number;
}

/** Human name for the file type we refused, so the error says what it is. */
function describeFileType(stats: {
  isDirectory(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
}): string {
  if (stats.isDirectory()) return 'directory';
  if (stats.isFIFO()) return 'FIFO';
  if (stats.isSocket()) return 'socket';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'non-regular file';
}

/**
 * Resolve a caller-supplied read path and refuse anything that leaves the
 * allowed roots, is not a regular file, or is over the size cap — all three
 * decided before a byte is read.
 *
 * Containment is decided on the REAL path, exactly as on the write side:
 * realpath() follows every symlink and collapses `..` first, so neither a
 * `..` segment nor a symlink planted at any component can widen the roots.
 * A FIFO, /proc entry or device node is refused by name rather than opened —
 * reading one blocks the serialized request queue forever.
 */
export async function resolveInputPath(options: ResolveInputOptions): Promise<ResolvedInput> {
  const { roots, tool, target, maxBytes = maxDocumentBytes(), envHint } = options;
  if (roots.length === 0) {
    throw new Error(`${tool}: no allowed read roots are configured, so "${target}" cannot be read.`);
  }
  const rootReals: string[] = [];
  for (const root of roots) {
    rootReals.push(await realpathAllowingMissing(resolve(root)));
  }
  const allowed = rootReals.join(', ');
  const suffix = envHint ? ` ${envHint}` : '';

  const expanded = target === '~'
    ? homedir()
    : target.startsWith('~/')
      ? join(homedir(), target.slice(2))
      : target;
  const requested = isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);

  let real: string;
  try {
    real = await realpath(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new Error(`${tool}: no readable file at "${target}" (${requested}). Allowed read roots: ${allowed}.${suffix}`);
    }
    throw new Error(`${tool}: cannot read "${target}" (${code ?? 'unknown error'}). Allowed read roots: ${allowed}.${suffix}`);
  }
  // Any one root admits the path — same containment rule as the write side.
  if (!rootReals.some((root) => isInsideRoot(root, real))) {
    throw new Error(
      `${tool}: refusing to read outside the allowed read roots — "${target}" resolves to ${real}. `
        + `Allowed read roots: ${allowed}.${suffix}`,
    );
  }

  const stats = await lstat(real);
  if (!stats.isFile()) {
    throw new Error(
      `${tool}: refusing to read "${target}" — ${real} is a ${describeFileType(stats)}, not a regular file. `
        + `Allowed read roots: ${allowed}.${suffix}`,
    );
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `${tool}: refusing to read ${stats.size} bytes from "${target}" — over the ${maxBytes}-byte `
        + `document limit (${Math.round(maxBytes / (1024 * 1024))} MB). Split the document and read it `
        + 'in pieces, or raise SPOTIFY_MCP_MAX_DOCUMENT_MB.',
    );
  }
  return { path: real, bytes: stats.size, maxBytes };
}

/**
 * Read a resolved document. O_NOFOLLOW closes the gap between the realpath
 * check and the open (a symlink swapped in after the check fails with ELOOP
 * instead of receiving the read), and the size is re-checked against the bytes
 * actually received so a file that grew after stat() cannot slip past the cap.
 */
export async function readInputFile(input: ResolvedInput, tool = 'read'): Promise<string> {
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = await handle.readFile({ encoding: 'utf8' });
    const bytes = Buffer.byteLength(data, 'utf8');
    if (bytes > input.maxBytes) {
      throw new Error(
        `${tool}: refused to parse ${bytes} bytes read from "${input.path}" — over the `
          + `${input.maxBytes}-byte document limit (${Math.round(input.maxBytes / (1024 * 1024))} MB). `
          + 'Split the document and read it in pieces, or raise SPOTIFY_MCP_MAX_DOCUMENT_MB.',
      );
    }
    return data;
  } finally {
    await handle.close();
  }
}
