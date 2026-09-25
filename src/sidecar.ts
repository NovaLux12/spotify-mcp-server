/**
 * Shared policy for the local JSON sidecars (#839).
 *
 * Every sidecar here is hand-curated user data (scenes, device presets,
 * bookmarks, checkpoints). The bug this module exists to prevent: a loader that
 * cannot parse the file returns an empty store, the next mutating call writes
 * that empty store back, and the user's data is gone behind an "ok" response
 * with no warning. A file that could not be read is an UNKNOWN store, not an
 * empty one.
 *
 * So the read path is split three ways instead of two:
 *   - absent (ENOENT)        -> empty store, `error: null`. Nothing was lost.
 *   - parsed to a JSON object -> that store, `error: null`.
 *   - anything else          -> the exact bytes are FIRST moved aside to
 *     `<name>.corrupt-<stamp>[-n]`, and the caller gets a non-null `error`
 *     naming the reason and the copy. Moving (not copying) matters: it leaves
 *     one surviving copy of the user's bytes, so no later write can race the
 *     last untouched original, and re-reading the same corrupt file cannot
 *     produce a second copy. Only ENOENT yields an empty store.
 *
 * Callers must not write a fresh store over a store whose `error` is set
 * unless the user explicitly asked to; `tools/scenes.ts` is the reference
 * shape (refuse by default, `overwrite_corrupt: true` to proceed).
 */
import { constants, copyFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Owner-only directory holding a sidecar, and owner-only sidecar file. */
export const SIDECAR_DIR_MODE = 0o700;
export const SIDECAR_FILE_MODE = 0o600;

/** Suffix every byte-preserved copy carries, so a user can find them by eye. */
const CORRUPT_SUFFIX = '.corrupt-';

export interface SidecarRead<T> {
  /**
   * The parsed store, or `empty()` when the file is absent. When `error` is set
   * this is an empty store standing for "unknown", never for "no entries".
   */
  store: T;
  /**
   * null when the file was absent or parsed. Non-null when it exists but could
   * not be turned into a store - a parse failure, a payload that is not a JSON
   * object, or a read error. The message names the reason and, when the bytes
   * were moved, where they went.
   */
  error: string | null;
  /** Absolute path now holding the moved-aside bytes, or null if none was made. */
  preserved_at: string | null;
}

/** Thrown by `readJsonSidecarOrThrow` for callers that must not see an empty store. */
export class SidecarUnreadableError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly preservedAt: string | null,
  ) {
    super(message);
    this.name = 'SidecarUnreadableError';
  }
}

/** Filesystem-safe UTC stamp, e.g. `2026-09-26T09-41-07-512Z`. */
function corruptStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A JSON object, not an array/null/primitive: anything else is an unreadable store. */
function isPlainStore(parsed: unknown): boolean {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the file's exact bytes to `<name>.corrupt-<stamp>[-n]`, never clobbering
 * an existing name. `link` gives that for free (EEXIST) and keeps the original
 * in place until the copy exists; a filesystem without hard links falls back to
 * an exclusive copy. Returns the path holding the bytes, or null when the move
 * failed - never a path that does not exist, in which case the original stands.
 */
async function moveAside(path: string): Promise<string | null> {
  const dir = dirname(path);
  const prefix = `${basename(path)}${CORRUPT_SUFFIX}`;
  try {
    await mkdir(dir, { recursive: true, mode: SIDECAR_DIR_MODE });
    const stamp = corruptStamp();
    for (let n = 0; n < 1000; n += 1) {
      const target = join(dir, `${prefix}${stamp}${n === 0 ? '' : `-${n}`}`);
      try {
        await link(path, target);
      } catch (err) {
        const code = errnoCode(err);
        if (code === 'EEXIST') continue; // name taken by an earlier corruption
        if (code === 'EPERM' || code === 'EXDEV' || code === 'ENOSYS' || code === 'EMLINK') {
          await copyFile(path, target, constants.COPYFILE_EXCL);
        } else {
          throw err;
        }
      }
      // The copy now exists and is byte-identical by construction; only now is
      // it safe to drop the original.
      await unlink(path);
      return target;
    }
    return null;
  } catch (err) {
    console.error(
      `[sidecar] could not preserve unreadable ${path}: ${reason(err)} — the original file is untouched.`,
    );
    return null;
  }
}

/**
 * Read a JSON sidecar under the #839 policy. Never throws for a missing or
 * unreadable file: the outcome is in `SidecarRead` so a tool can report it.
 */
export async function readJsonSidecar<T extends object>(
  path: string,
  empty: () => T,
): Promise<SidecarRead<T>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { store: empty(), error: null, preserved_at: null };
    // The bytes never reached us, so there is nothing to move: say so rather
    // than naming a preserved path that does not exist.
    return {
      store: empty(),
      error: `${path} could not be read (${reason(err)}); nothing was preserved because its bytes were not readable.`,
      preserved_at: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return unreadable(path, `it is not valid JSON (${reason(err)})`, empty);
  }
  if (!isPlainStore(parsed)) {
    return unreadable(
      path,
      `it parses as ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : typeof parsed}, not a JSON object`,
      empty,
    );
  }
  return { store: parsed as T, error: null, preserved_at: null };
}

async function unreadable<T extends object>(
  path: string,
  why: string,
  empty: () => T,
): Promise<SidecarRead<T>> {
  const preserved = await moveAside(path);
  const outcome =
    preserved === null
      ? 'It could NOT be preserved, so the file is still there, untouched: fix or remove it by hand.'
      : `Its bytes were moved to ${preserved} and the store path is now empty.`;
  return { store: empty(), error: `${path} was unreadable: ${why}. ${outcome}`, preserved_at: preserved };
}

/** `readJsonSidecar` for callers that must stop rather than see an empty store. */
export async function readJsonSidecarOrThrow<T extends object>(
  path: string,
  empty: () => T,
): Promise<T> {
  const read = await readJsonSidecar(path, empty);
  if (read.error !== null) throw new SidecarUnreadableError(read.error, path, read.preserved_at);
  return read.store;
}

/**
 * Write the store atomically-enough: an owner-only temp file beside the
 * target, then a rename. A crash or a full disk mid-write leaves the previous
 * file intact rather than a half-written one.
 */
export async function writeJsonSidecar(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: SIDECAR_DIR_MODE });
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${corruptStamp()}`);
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: SIDECAR_FILE_MODE });
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}
