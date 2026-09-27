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
import { closeSync, constants, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { storePath } from './config.js';

/**
 * Output root for tools that have no directory of their own
 * (export_playlist, export_profile_state).
 * NEW ENV VAR SPOTIFY_MCP_EXPORT_DIR — default ~/.spotify-mcp/exports.
 */
export function exportRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('exports', env);
}

/**
 * Retention window for the library-backup store (#697). Snapshots are dated
 * compilations of the user's saves, so an unbounded store accumulates dated
 * personal data with no path to removal; the window makes expiry the default
 * and delete_backup the manual escape hatch.
 *
 * NEW ENV VAR SPOTIFY_MCP_BACKUP_RETENTION_DAYS — whole days a snapshot is
 * kept. Default 30. 0 disables pruning entirely. Anything unusable (empty,
 * non-numeric, negative, fractional) falls back to the default rather than
 * silently becoming "keep forever"; the floor for an ENABLED window is
 * MIN_BACKUP_RETENTION_DAYS, so the smallest non-zero window is one day.
 */
const DEFAULT_BACKUP_RETENTION_DAYS = 30;
const MIN_BACKUP_RETENTION_DAYS = 1;

export function backupRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPOTIFY_MCP_BACKUP_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_BACKUP_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0 || !Number.isInteger(days)) return DEFAULT_BACKUP_RETENTION_DAYS;
  if (days === 0) return 0;
  return Math.max(MIN_BACKUP_RETENTION_DAYS, days);
}

/**
 * realpath() that tolerates a not-yet-created leaf: the deepest existing
 * ancestor is resolved and the missing tail re-attached, so a brand-new
 * directory is still compared by its real location. Any other errno (EACCES,
 * ELOOP) propagates instead of silently passing an unresolved path.
 */
export async function realpathAllowingMissing(target: string): Promise<string> {
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

/**
 * Backup store root (library snapshots, playlist snapshots, bookmarks).
 * NEW ENV VAR SPOTIFY_MCP_BACKUP_DIR — default ~/.spotify-mcp/backups.
 *
 * This lives here, beside `exportRootDir`, so the READ roots below and the
 * backup WRITER agree on one definition of the directory. It used to be
 * defined in src/tools/backup.ts, which imports this module — so the read
 * side could not reach it without a cycle, and the alternative was a second,
 * subtly different root list (the drift this issue is about). backup.ts
 * re-exports it, so every existing `from './backup.js'` import is unchanged.
 */
export function backupRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('backups', env);
}

/** Synchronous twin of `realpathAllowingMissing`; same ENOENT/ENOTDIR rule. */
function realpathAllowingMissingSync(target: string): string {
  const missing: string[] = [];
  let current = resolve(target);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      // Reached the filesystem root: realpath() always succeeds there.
      if (parent === current) return join(realpathSync(current), ...missing);
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

interface ResolveOutputBase {
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

interface ResolveOutputOptions extends ResolveOutputBase {
  kind: 'file' | 'directory';
}

/** Resolved destination for a directory: the directory to write into. */
interface ResolvedDirectory {
  /** Absolute, symlink-resolved directory the tool may write into. */
  readonly dir: string;
}

/** Resolved destination for a file: its parent, plus the file itself. */
interface ResolvedFile extends ResolvedDirectory {
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
export function isInsideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// ---------------------------------------------------------------------------
// Read side (#623). Everything below is additive: the write-side helpers above
// are untouched.
//
// THE guard, and the only one in the repo. Three hazards, three refusals, each
// naming its own actual reason:
//
//   1. outside the allowed read roots  (a `..` segment, an absolute path, or
//      a symlink at any component resolves out of the root)
//   2. not a regular file               (a directory, FIFO, socket, or device
//      — a FIFO blocks the serialized request queue forever and /dev/zero
//      never ends)
//   3. over the document size cap       (an unbounded read of a huge or
//      endless file exhausts memory)
//
// The DECISIONS live in `decideInputPath` below and in the `refuse*` builders.
// The sync and async entry points are the same function over the same
// decisions with different fs calls, so the two can never disagree about a
// borderline path — the drift that left seven read sites with an ad-hoc check
// at three of them is what this replaces. `readLocalFile` / `readLocalFileSync`
// are the form every call site should use.
// ---------------------------------------------------------------------------

/** Default ceiling on a document a tool will pull into memory: 32 MB. */
const DEFAULT_MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

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

interface ResolveInputOptions {
  /**
   * Every directory a read may come from; anything else is refused. Callers
   * build this from the path resolver they ALREADY use (their own
   * `*Dir()` / `*Path()`), never from a second, separately-maintained root
   * list — a parallel root scheme that drifts from the writer's is the same
   * bug wearing a different hat.
   */
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

interface ResolvedInput {
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
 * Stat shape both the sync and async paths need. `lstatSync` and
 * `fs/promises.lstat` both return `Stats` here — neither is called with
 * `{ bigint: true }`, so the non-bigint shape is the whole story.
 */
type StatLike = Stats;

/** Context the three refusals are built from, so each names its own reason. */
interface RefusalContext {
  tool: string;
  target: string;
  /** Pre-formatted "Allowed read roots: …" plus the optional env hint. */
  allowed: string;
  suffix: string;
}

/**
 * THE three decisions, in the order they are made, with no fs access of their
 * own. Both `resolveInputPath` and `resolveInputPathSync` end here, so the two
 * entry points cannot drift apart about what counts as safe to read.
 *
 * Containment is decided on the REAL path, exactly as on the write side:
 * realpath() follows every symlink and collapses `..` first, so neither a
 * `..` segment nor a symlink planted at any component can widen the roots. A
 * FIFO, /proc entry or device node is refused by name rather than opened —
 * reading one blocks the serialized request queue forever.
 */
function decideInputPath(
  real: string,
  rootReals: readonly string[],
  stats: StatLike,
  maxBytes: number,
  ctx: RefusalContext,
): ResolvedInput {
  // Any one root admits the path — same containment rule as the write side.
  if (!rootReals.some((root) => isInsideRoot(root, real))) {
    throw new Error(
      `${ctx.tool}: refusing to read outside the allowed read roots — "${ctx.target}" resolves to ${real}. `
        + `Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
    );
  }
  if (!stats.isFile()) {
    throw new Error(
      `${ctx.tool}: refusing to read "${ctx.target}" — ${real} is a ${describeFileType(stats)}, not a regular file. `
        + `Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
    );
  }
  if (stats.size > maxBytes) {
    throw new Error(
      `${ctx.tool}: refusing to read ${stats.size} bytes from "${ctx.target}" — over the ${maxBytes}-byte `
        + `document limit (${Math.round(maxBytes / (1024 * 1024))} MB). Split the document and read it `
        + 'in pieces, or raise SPOTIFY_MCP_MAX_DOCUMENT_MB.',
    );
  }
  return { path: real, bytes: stats.size, maxBytes };
}

/** `~` expansion + absolutising, shared so both entry points agree. */
/**
 * Expand a caller-supplied path against the PROCESS home and cwd.
 *
 * ## Why this `homedir()` is not one of ours (#711)
 *
 * `target` is the string a CALLER passed — a file they are importing, a
 * document they are reading. Two reasons it does not belong in the store
 * registry:
 *
 *  - The registry is an inventory of places THIS SERVER WRITES. This expands
 *    somewhere the server only ever reads, and only because the user named it.
 *  - `logout` must not be handed a path it does not own. A registry entry here
 *    would make a user's chosen import path an erasure candidate, and the
 *    refusal that would then protect it is a refusal that reads as a bug to
 *    anyone who meant to clean up their own files.
 *
 * The process home is also the right home: it is what `~` meant to the user
 * whose shell they typed the path into, and this function's callers confine the
 * result to a read root before any byte is read.
 */
function absolutizeTarget(target: string): string {
  const expanded = target === '~'
    ? homedir()
    : target.startsWith('~/')
      ? join(homedir(), target.slice(2))
      : target;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/** The "here are your roots" tail every refusal carries. */
function refusalContext(options: ResolveInputOptions, rootReals: readonly string[]): RefusalContext {
  return {
    tool: options.tool,
    target: options.target,
    allowed: rootReals.join(', '),
    suffix: options.envHint ? ` ${options.envHint}` : '',
  };
}

function requireRoots(options: ResolveInputOptions): void {
  if (options.roots.length === 0) {
    throw new Error(
      `${options.tool}: no allowed read roots are configured, so "${options.target}" cannot be read.`,
    );
  }
}

/**
 * A refusal that KEEPS the errno it replaced.
 *
 * The guard turns "no such file" into a sentence that also names the allowed
 * roots, and a caller that branched on `err.code === 'ENOENT'` would stop
 * being able to tell a first run from a corruption — which is exactly the
 * distinction `loadSidecar` and the #839 work turn on. Carrying `code`
 * through preserves both: the errno for anyone branching on it, the sentence
 * for whoever reads the message.
 */
function refusal(message: string, code?: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code) err.code = code;
  return err;
}

/**
 * Resolve a caller-supplied read path and refuse anything that leaves the
 * allowed roots, is not a regular file, or is over the size cap — all three
 * decided before a byte is read.
 */
export async function resolveInputPath(options: ResolveInputOptions): Promise<ResolvedInput> {
  const maxBytes = options.maxBytes ?? maxDocumentBytes();
  requireRoots(options);
  const rootReals: string[] = [];
  for (const root of options.roots) {
    rootReals.push(await realpathAllowingMissing(resolve(root)));
  }
  const ctx = refusalContext(options, rootReals);
  const requested = absolutizeTarget(options.target);

  let real: string;
  try {
    real = await realpath(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw refusal(
        `${ctx.tool}: no readable file at "${options.target}" (${requested}). Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
        code,
      );
    }
    throw refusal(
      `${ctx.tool}: cannot read "${options.target}" (${code ?? 'unknown error'}). Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
      code,
    );
  }
  return decideInputPath(real, rootReals, await lstat(real), maxBytes, ctx);
}

/**
 * Synchronous twin of `resolveInputPath`, for the sidecar loaders that are on
 * a sync read path. Same three decisions (`decideInputPath`), same messages;
 * only the fs calls differ.
 */
export function resolveInputPathSync(options: ResolveInputOptions): ResolvedInput {
  const maxBytes = options.maxBytes ?? maxDocumentBytes();
  requireRoots(options);
  const rootReals = options.roots.map((root) => realpathAllowingMissingSync(resolve(root)));
  const ctx = refusalContext(options, rootReals);
  const requested = absolutizeTarget(options.target);

  let real: string;
  try {
    real = realpathSync(requested);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw refusal(
        `${ctx.tool}: no readable file at "${options.target}" (${requested}). Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
        code,
      );
    }
    throw refusal(
      `${ctx.tool}: cannot read "${options.target}" (${code ?? 'unknown error'}). Allowed read roots: ${ctx.allowed}.${ctx.suffix}`,
      code,
    );
  }
  return decideInputPath(real, rootReals, lstatSync(real), maxBytes, ctx);
}

/**
 * Read a resolved document. O_NOFOLLOW closes the gap between the realpath
 * check and the open (a symlink swapped in after the check fails with ELOOP
 * instead of receiving the read), and the size is re-checked against the bytes
 * actually received so a file that grew after stat() cannot slip past the cap.
 *
 * A file over the cap is REFUSED — never truncated and handed back. A
 * truncated body that reads as a complete document is the read-side twin of
 * the "failed lookup coerced to a plausible number" bug (#803).
 */
export async function readInputFile(input: ResolvedInput, tool = 'read'): Promise<string> {
  const handle = await open(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return assertWithinCap(await handle.readFile({ encoding: 'utf8' }), input, tool);
  } finally {
    await handle.close();
  }
}

/** Synchronous twin of `readInputFile`; same O_NOFOLLOW, same cap re-check. */
export function readInputFileSync(input: ResolvedInput, tool = 'read'): string {
  const fd = openSync(input.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return assertWithinCap(readFileSync(fd, 'utf8'), input, tool);
  } finally {
    closeSync(fd);
  }
}

function assertWithinCap(data: string, input: ResolvedInput, tool: string): string {
  const bytes = Buffer.byteLength(data, 'utf8');
  if (bytes > input.maxBytes) {
    throw new Error(
      `${tool}: refused to parse ${bytes} bytes read from "${input.path}" — over the `
        + `${input.maxBytes}-byte document limit (${Math.round(input.maxBytes / (1024 * 1024))} MB). `
        + 'Split the document and read it in pieces, or raise SPOTIFY_MCP_MAX_DOCUMENT_MB.',
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// The one call every read site should make: validate, then read.
// ---------------------------------------------------------------------------

interface ReadLocalFileOptions extends Omit<ResolveInputOptions, 'maxBytes'> {
  /** Byte ceiling; defaults to maxDocumentBytes(). */
  maxBytes?: number;
}

/**
 * Validate then read, in one call. This is the function every local read in
 * the repo goes through; `resolveInputPath` + `readInputFile` remain exported
 * for the sites that need the resolved path for their own bookkeeping.
 */
export async function readLocalFile(options: ReadLocalFileOptions): Promise<string> {
  const input = await resolveInputPath(options);
  return readInputFile(input, options.tool);
}

/** Synchronous twin of `readLocalFile`. */
export function readLocalFileSync(options: ReadLocalFileOptions): string {
  return readInputFileSync(resolveInputPathSync(options), options.tool);
}

/**
 * The default allowed READ roots: the directories this server itself writes
 * documents into, plus anything the operator opts into via
 * `SPOTIFY_MCP_ALLOW_PATHS` (colon-separated, like PATH).
 *
 * NEW ENV VAR SPOTIFY_MCP_ALLOW_PATHS — extra directories a caller-supplied
 * read path may resolve inside.
 */
export function readRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = (env.SPOTIFY_MCP_ALLOW_PATHS ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [
    // Through the registry, so a read root cannot disagree with the directory
    // the tool that writes there resolved (#711). This line used to be a THIRD
    // copy of the portability default, alongside the one in `portability.ts`
    // and the one in its own `listeningHistoryDir`.
    storePath('portability', env),
    backupRootDir(env),
    exportRootDir(env),
    ...extra,
  ];
}

/** The hint every caller-supplied-read refusal carries, naming what to set. */
export const READ_ROOTS_ENV_HINT =
  'Set SPOTIFY_MCP_PORTABILITY_DIR / SPOTIFY_MCP_BACKUP_DIR / SPOTIFY_MCP_EXPORT_DIR, '
  + 'or add the directory to SPOTIFY_MCP_ALLOW_PATHS.';

/**
 * The roots for a SERVER-OWNED store: the directory holding the file the
 * caller never named. Confinement still earns its place here — a store path
 * that a caller-influenced id (a playlist id, a snapshot id) helped build can
 * otherwise walk out of its own directory — and the regular-file and size-cap
 * checks are the ones that stop a FIFO planted in the data dir from hanging
 * the server.
 *
 * Built from the caller's EXISTING path resolver so there is exactly one
 * definition of where each store lives.
 */
export function ownStoreRoots(path: string): string[] {
  return [dirname(resolve(path))];
}
