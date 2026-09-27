/**
 * Shared policy for local JSON sidecars (#839, #1051).
 *
 * ENOENT reads as empty. Every other read failure, every JSON parse failure,
 * and every validation failure is SURFACED. The corrupt bytes are COPIED to
 * `<file>.corrupt` (or `<file>.corrupt.N` when `<file>.corrupt` already
 * exists) at 0600, by `fs.copyFile` with the `COPYFILE_EXCL` flag
 * (`FS.COPYFILE_EXCL`, not the unrelated `O_EXCL` of `open(2)`) so a second
 * corruption cannot clobber the earlier preserved copy, and the original is
 * left on disk untouched; the error says so and names the earlier copy as
 * still intact. The error is a `SidecarUnreadableError`, never a silent empty
 * store.
 *
 * "Copied", not moved: nothing here renames or unlinks the original, so the
 * bytes exist in two places afterwards. `tests/searchhistory-corrupt.test.ts`
 * and `tests/tools.libraryinsights.test.ts` assert both halves — the `.corrupt`
 * copy is byte-identical *and* the original still reads back with its corrupt
 * contents — and that pair is what keeps this header from drifting again.
 *
 * This is the loader for playbackext, exhaust2_playback, exhaust2_misc,
 * libraryinsights (genre tags), and scenes. Re-deriving the policy per module
 * is what let four loaders drift apart — the shared module is the one place
 * to fix.
 */
import { copyFile, chmod, lstat } from 'node:fs/promises';
import { copyFileSync, existsSync, lstatSync, chmodSync, constants as FS } from 'node:fs';
import { ownStoreRoots, readLocalFile, readLocalFileSync } from './paths.js';

export class SidecarUnreadableError extends Error {
  readonly path: string;
  readonly reason: string;
  readonly preservedAs: string | null;

  constructor(path: string, reason: string, preservedAs: string | null) {
    super(formatSidecarMessage(path, reason, preservedAs));
    this.name = 'SidecarUnreadableError';
    this.path = path;
    this.reason = reason;
    this.preservedAs = preservedAs;
  }
}

/**
 * Build the one-line error report the loader raises on any unreadable
 * sidecar. The message names the path that could not be read, the reason it
 * failed, the location of the preserved copy when one was made, and (when
 * this is the second-or-later corruption) the location of the earlier copy
 * that is still on disk so the user knows which file is the one to repair
 * from (#1051).
 */
function formatSidecarMessage(path: string, reason: string, preservedAs: string | null): string {
  if (preservedAs === null) {
    return `${path} is unreadable (${reason}) and could not be moved aside, so it is still in place; it was not loaded.`;
  }
  const earlier = preservedAs.endsWith('.corrupt')
    ? ''
    : ` An earlier detection's copy is still at ${preservedAs.replace(/\.corrupt\.\d+$/, '.corrupt')}, kept intact so the original post-crash state was not overwritten.`;
  return `${path} is unreadable (${reason}). Its exact bytes were preserved at ${preservedAs} and it was left untouched — repair or move it aside, then retry.${earlier}`;
}

/**
 * Copy an unusable sidecar's bytes to `<file>.corrupt` so the original is
 * never lost to the next write (#1051). `copyFile(file, target,
 * COPYFILE_EXCL)` is used so the copy is byte-identical AND a second
 * corruption never clobbers the earlier preserved copy (POSIX rename would
 * overwrite an existing target). The first copy uses `<file>.corrupt`;
 * later copies use `<file>.corrupt.N` (1, 2, 3, …) so the earlier preserved
 * copy is never lost. Returns the path the bytes now live at, or null when
 * they could not be copied (in which case the caller must say the file is
 * still in place rather than imply it is gone).
 *
 * The original file is left on disk — a hardlink would let the very next
 * `writeFile` truncate the preserved copy's inode, defeating the whole
 * point. The bytes are duplicated, which is cheap for a JSON sidecar and
 * is what `library_genre_report` callers have always been able to assume.
 */
export async function preserveUnreadableSidecar(file: string): Promise<string | null> {
  // A quarantine that COPIES the file opens it for reading, so it inherits
  // the hazard the read guard just refused: copyFile() on a FIFO blocks
  // forever, and on a device node never returns. Only a regular file can be
  // preserved; anything else stays in place, which the caller's error already
  // says ("could not be moved aside, so it is still in place") rather than
  // implying the bytes are safe somewhere else (#623).
  if (!(await isRegularFile(file))) return null;
  for (let n = 0; n < 50; n++) {
    const target = n === 0 ? `${file}.corrupt` : `${file}.corrupt.${n}`;
    try {
      await copyFile(file, target, FS.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue; // an earlier copy owns this name
      if (code === 'ENOENT') return null; // the file went away under us
      return null;
    }
    // Best-effort mode tighten: read-only or full directory must not mask the
    // corruption report itself, and 0600 matches every other sidecar in this
    // repo so the preserved bytes never leak.
    await chmod(target, 0o600).catch(() => undefined);
    return target;
  }
  return null;
}

/**
 * Synchronous twin of `preserveUnreadableSidecar`. Same policy, expressed
 * with the sync fs API for the sidecars that already use it — the genre-tag
 * loader has callers on the sync read path and would otherwise grow a
 * separate inline preservation that would drift again (#1051).
 */
export function preserveUnreadableSidecarSync(file: string): string | null {
  // Same reason as the async twin above: a quarantine copy opens the file, so
  // it must never be attempted on a FIFO or a device node.
  if (!isRegularFileSync(file)) return null;
  for (let n = 0; n < 50; n++) {
    const target = n === 0 ? `${file}.corrupt` : `${file}.corrupt.${n}`;
    try {
      copyFileSync(file, target, FS.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') continue;
      if (code === 'ENOENT') return null;
      return null;
    }
    try { chmodSync(target, 0o600); } catch { /* best-effort */ }
    return target;
  }
  return null;
}

/**
 * The reason a read failed, for the `SidecarUnreadableError`.
 *
 * A raw errno loses the point: the #623 guard refuses with a message that
 * says WHICH of the three hazards applied — outside the read roots, not a
 * regular file, or over the size cap — and that is the thing the operator has
 * to act on. So an errno keeps the terse form, and a guard refusal (no errno,
 * a full sentence) is reported as itself.
 */
function describeReadFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code) return `read failed: ${code}`;
  return err instanceof Error ? err.message : String(err);
}

/** True iff `file` is a regular file — the only thing a quarantine may copy. */
async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

/** Synchronous twin of `isRegularFile`. */
function isRegularFileSync(file: string): boolean {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
}

export interface LoadSidecarOptions {
  /**
   * A copy this process already made for the corruption currently on disk, or
   * `null` when a previous attempt already failed to make one. Suppresses a
   * *second copy* and nothing else: the read is still attempted, so the verdict
   * always describes the file as it is right now. A loader on a hot path needs
   * this — search history is loaded by every search, and without it one corrupt
   * file leaves one identical `.corrupt.N` per call, fifty of them before the
   * helper gives up. Omit it (the default) to preserve on every failure.
   */
  alreadyPreserved?: string | null;
}

/**
 * Read + parse + validate a JSON sidecar, preserving the bytes before throwing
 * on any read/parse/validation failure. ENOENT returns the empty value from
 * `makeEmpty` — a first run, not a corruption. Every other failure throws a
 * `SidecarUnreadableError` with `path`, `reason`, and `preservedAs` populated.
 */
export async function loadSidecar<T>(
  file: string,
  makeEmpty: () => T,
  validate: (parsed: unknown) => T,
  options: LoadSidecarOptions = {},
): Promise<T> {
  // `undefined` means "no prior attempt to reuse" — only an explicit null (a
  // prior attempt that could not copy) suppresses a fresh one.
  const preserve = (): Promise<string | null> =>
    options.alreadyPreserved !== undefined
      ? Promise.resolve(options.alreadyPreserved as string | null)
      : preserveUnreadableSidecar(file);
  let text: string;
  try {
    // Every sidecar read in the server funnels through here, so this is where
    // the #623 guard belongs: a regular-file check (a FIFO planted in the data
    // dir would otherwise block the serialized request queue forever) and a
    // size cap (an unbounded read of a huge file exhausts memory), plus
    // confinement to the store's own directory so a caller-influenced id
    // cannot walk out of it. A refusal becomes a SidecarUnreadableError
    // carrying ITS reason, so "is a FIFO" is never reported as a bare
    // "read failed: EISDIR".
    text = await readLocalFile({ roots: ownStoreRoots(file), tool: 'sidecar', target: file });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return makeEmpty();
    const preserved = await preserve();
    throw new SidecarUnreadableError(file, describeReadFailure(err), preserved);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const preserved = await preserve();
    throw new SidecarUnreadableError(
      file,
      `is not valid JSON: ${(err as Error).message}`,
      preserved,
    );
  }
  try {
    return validate(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const preserved = await preserve();
    throw new SidecarUnreadableError(file, msg, preserved);
  }
}

/** True iff the named sidecar has a preserved copy on disk. */
export function hasPreservedCopy(file: string): boolean {
  return existsSync(`${file}.corrupt`);
}

/**
 * Synchronous twin of `loadSidecar`. Same policy, same error class, same
 * preservation rules. Used by loaders whose callers are on the sync read path
 * (the genre-tag loader has direct test callers that pass paths and assert
 * with `assert.throws`; turning it async would touch every one).
 */
export function loadSidecarSync<T>(
  file: string,
  makeEmpty: () => T,
  validate: (parsed: unknown) => T,
): T {
  let text: string;
  try {
    // Same guard as the async loader above, over the same three decisions.
    text = readLocalFileSync({ roots: ownStoreRoots(file), tool: 'sidecar', target: file });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return makeEmpty();
    const preserved = preserveUnreadableSidecarSync(file);
    throw new SidecarUnreadableError(file, describeReadFailure(err), preserved);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const preserved = preserveUnreadableSidecarSync(file);
    throw new SidecarUnreadableError(
      file,
      `is not valid JSON: ${(err as Error).message}`,
      preserved,
    );
  }
  try {
    return validate(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const preserved = preserveUnreadableSidecarSync(file);
    throw new SidecarUnreadableError(file, msg, preserved);
  }
}