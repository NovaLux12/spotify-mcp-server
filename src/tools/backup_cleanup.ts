/**
 * `clean_backup_artifacts` — the missing sibling of `delete_backup` (#1592).
 *
 * THE GAP. `SPOTIFY_MCP_BACKUP_DIR` is not a library-backup store with some
 * extra files in it; it is a SHARED directory that four writers use, and only
 * one of the four is reachable through the tools. Every read, list, retention
 * and delete path filters on `BACKUP_FILE_RE` (`backup-YYYY-MM-DD-N[.partial]
 * .json`, `backup.ts:203`), so the other families are invisible to all of them:
 *
 *   | written by                          | name shape                                  |
 *   |-------------------------------------|---------------------------------------------|
 *   | `backup_library` / `backup_first`   | `backup-YYYY-MM-DD-N[.partial].json`  ← in scope for `delete_backup` |
 *   |   …plus one metadata sidecar each   | `backup-YYYY-MM-DD-N.meta.json`      ← in scope, removed with its snapshot |
 *   | `listening_session_start`/`_close`  | `listening-session-<safe>.json`       ← NOT reachable by any tool |
 *   | playlist-write pre-images           | `playlistops-pre-<id>-<stamp>.json`  ← NOT reachable by any tool |
 *   | legacy playback bookmarks           | `playback-bookmark-<id>.json`        ← NOT reachable by any tool |
 *   | `migrate_playback_positions`        | `playback-bookmark-<id>.json.migrated`← NOT reachable by any tool |
 *
 * `delete_backup`'s `reason: 'not_a_backup'` refusal for all of the above is
 * FAIL-CLOSED AND CORRECT and is not weakened here. That tool is named for
 * library backups, cannot describe the other four families in its own result
 * payload, and a caller who names a listening session deserves to be told it is
 * not one rather than have it unlinked by a tool whose name promised otherwise.
 * The fix is the ABSENCE OF A SIBLING, not a hole in the existing gate.
 *
 * So: this tool exists to expire and delete the non-library families, and
 * refuses library backups by name — pointing at `delete_backup`, which is the
 * tool that owns them.
 *
 * WHY EACH FAMILY IS SAFE TO REMOVE. The point of an expiry window is that the
 * thing being discarded is recoverable-by-recreation or already duplicated
 * elsewhere. None of these four is a library snapshot:
 *
 *   • listening sessions are an append-and-close log. Once a session is closed
 *     and its report read, the file is spent.
 *   • playlist pre-images exist so a bad write can be undone BY HAND shortly
 *     after it happens. The durable undo path is the receipt ledger
 *     (`undo_mutation`); the pre-image is the belt-and-braces local copy that
 *     nothing reads back (`swarm3_playlistops.ts:245` writes it and nothing in
 *     `src/` opens it).
 *   • legacy bookmarks were superseded by the canonical position store
 *     (#846). This build no longer WRITES them: the only paths that touch one
 *     are `migrate_playback_positions` (which renames it to `.migrated`) and
 *     `delete_playback_bookmark` (which unlinks it). A file on disk under
 *     either name is by definition a leftover from before that migration, and
 *     the migration is what COPIED its contents into the store before renaming.
 *
 * ALWAYS CONFIRMS, WITH NO COUNT THRESHOLD. `confirm.ts` has both patterns:
 * threshold gates (`REMOVE_ELICIT_THRESHOLD = 10`) and four operations that ask
 * unconditionally. This one is the second kind, because its direct sibling is.
 * `delete_backup` asks for ONE file in this same directory; a tool that
 * unlinks many of the same files, unrecoverably, must not be reachable by
 * FEWER prompts than the one that deletes a single one. A threshold would make
 * 40 stale sessions the easy path and 1 deliberate cleanup the annoying one,
 * which is exactly backwards. Preview is the cheap half of the safety and it
 * is the default, so the prompt is one extra `dry_run: false` away for whoever
 * asked for the sweep in the first place.
 */
import { z } from 'zod';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat, DryRunDefault, describeDryRun, isDryRun } from '../shaping.js';
import { backupArtifactRetentionDays, resolveOutputPath } from '../paths.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import {
  BACKUP_FILE_RE,
  backupDir,
  formatBytes,
  readStoreEntries,
  shapeResult,
  storeEnvelope,
} from './backup.js';

const DAY_MS = 86_400_000;

/** How many filenames a confirmation or preview enumerates before summarising. */
const MAX_LISTED_NAMES = 20;

/**
 * The non-library families, in the order they are reported.
 *
 * Each pattern is derived from the code that WRITES the name, not from what the
 * file contains, because the name is all this tool is allowed to match on:
 *
 *  - `sessionPath()` builds `listening-session-<safe>.json` where `<safe>` is
 *    the id with every character outside `[A-Za-z0-9._-]` replaced by `_`
 *    (`swarm3_playback.ts:257-260`).
 *  - `backupItemsBeforeWrite()` builds
 *    `playlistops-pre-<safeId>-<stamp>.json`, both halves scrubbed the same way
 *    (`swarm3_playlistops.ts:228-236`).
 *  - `legacyBookmarkPath()` builds `playback-bookmark-<safeId>.json`; the
 *    migration renames that to `<name>.migrated`
 *    (`playbackpositions.ts:588-591`, `:554`).
 *
 * `.migrated` is listed as its own pattern rather than folded into the
 * bookmark one. The two are disjoint (the bookmark pattern is `$`-anchored on
 * `.json`, which `.migrated` can never satisfy), but naming both keeps the
 * report able to say WHICH shape it is proposing to delete, and a user who
 * wants to clear spent bookmarks without touching the migration markers is
 * then choosing rather than guessing.
 */
const FAMILIES: ReadonlyArray<{ key: string; label: string; re: RegExp }> = Object.freeze([
  { key: 'sessions', label: 'listening sessions', re: /^listening-session-[A-Za-z0-9._-]+\.json$/ },
  { key: 'pre_images', label: 'playlist write pre-images', re: /^playlistops-pre-[A-Za-z0-9._-]+\.json$/ },
  { key: 'bookmarks', label: 'legacy playback bookmarks', re: /^playback-bookmark-[A-Za-z0-9._-]+\.json$/ },
  { key: 'migrated_bookmarks', label: 'migrated playback bookmarks', re: /^playback-bookmark-[A-Za-z0-9._-]+\.json\.migrated$/ },
]);

/** The `family` argument's own enumeration, `all` meaning "every family". */
const FamilyArg = z
  .enum(['all', 'sessions', 'pre_images', 'bookmarks', 'migrated_bookmarks'])
  .optional()
  .describe('Which non-library family to act on. Default all.');

/** Which family a directory entry belongs to, or null when it is not ours. */
function familyOf(name: string): { key: string; label: string } | null {
  for (const family of FAMILIES) {
    if (family.re.test(name)) return { key: family.key, label: family.label };
  }
  return null;
}

/**
 * A library backup by another route than `BACKUP_FILE_RE` — the metadata
 * sidecar, whose name is derived by appending `.meta.json` to a snapshot name
 * (`metadataSidecarPath`, `backup.ts:911-913`). `BACKUP_FILE_RE` does not match
 * it, so a sidecar would otherwise fall through to "unrecognised" and be
 * reported as a mystery file rather than as what it is. It is still never
 * touched: it belongs to a library snapshot, and `delete_backup` removes it
 * with that snapshot so the pair cannot be split.
 */
function isLibrarySidecar(name: string): boolean {
  if (!name.endsWith('.meta.json')) return false;
  return BACKUP_FILE_RE.test(`${name.slice(0, -'.meta.json'.length)}.json`);
}

interface Candidate {
  name: string;
  path: string;
  family: string;
  label: string;
  bytes: number;
  ageDays: number;
}

interface Inventory {
  candidates: Candidate[];
  libraryBackups: { name: string; bytes: number }[];
  librarySidecars: { name: string; bytes: number }[];
  /** Regular files matching no known family. Never deleted — see below. */
  unrecognised: { name: string; bytes: number }[];
  /** Symlinks, FIFOs, directories. Never deleted, never read. */
  notRegular: string[];
  /** Sum of every regular file in the directory, measured by lstat. */
  directoryBytes: number;
}

/**
 * Measure the directory. One pass, and it is a MEASUREMENT: every size comes
 * from `lstat` on the real entry.
 *
 * `unrecognised` is reported and then deliberately left alone rather than
 * cleaned up. This tool knows the name shapes four writers produce; anything
 * else under that directory is either a hand-placed file or a family added by a
 * build newer than this one, and deleting a file this code cannot name is how
 * `delete_backup` ended up with a fail-closed refusal in the first place. The
 * honest move is to list it and let a human decide.
 *
 * Ages come from mtime, which is what is reported: none of these four families
 * records its own creation date in a shape worth parsing a whole directory to
 * recover, and `readStoreEntry` already falls back to `st.mtime` for library
 * snapshots for the same reason. The output names the source so no caller reads
 * an mtime as a recorded `started_at`.
 */
async function inventoryDirectory(dir: string, now: number): Promise<Inventory> {
  const empty: Inventory = {
    candidates: [], libraryBackups: [], librarySidecars: [],
    unrecognised: [], notRegular: [], directoryBytes: 0,
  };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return empty;
  }
  const out: Inventory = { ...empty, candidates: [], libraryBackups: [], librarySidecars: [], unrecognised: [], notRegular: [] };
  for (const name of names) {
    const path = join(dir, name);
    const st = await lstat(path).catch(() => null);
    if (!st) continue;
    // A symlink planted under a family name is never a deletion target and is
    // never followed: `lstat` does not resolve it, so its size is the link's
    // and its target's bytes are never counted or unlinked. Same rule as
    // `readStoreEntry`'s `regularFile` gate (#623).
    if (!st.isFile()) {
      out.notRegular.push(name);
      continue;
    }
    out.directoryBytes += st.size;
    if (BACKUP_FILE_RE.test(name)) { out.libraryBackups.push({ name, bytes: st.size }); continue; }
    if (isLibrarySidecar(name)) { out.librarySidecars.push({ name, bytes: st.size }); continue; }
    const family = familyOf(name);
    if (family === null) { out.unrecognised.push({ name, bytes: st.size }); continue; }
    out.candidates.push({
      name,
      path,
      family: family.key,
      label: family.label,
      bytes: st.size,
      ageDays: Math.max(0, (now - st.mtimeMs) / DAY_MS),
    });
  }
  return out;
}

/** `listening sessions: 3 file(s), 12.0 KiB` for each family that matched. */
function familySummary(candidates: Candidate[]): string[] {
  const grouped = new Map<string, { label: string; count: number; bytes: number }>();
  for (const c of candidates) {
    const row = grouped.get(c.family) ?? { label: c.label, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += c.bytes;
    grouped.set(c.family, row);
  }
  return [...grouped.values()].map((r) => `${r.label}: ${r.count} file(s), ${formatBytes(r.bytes)}`);
}

function nameList(candidates: Candidate[]): string[] {
  const shown = candidates.slice(0, MAX_LISTED_NAMES).map((c) => `${c.name} (${formatBytes(c.bytes)}, ${c.ageDays.toFixed(1)}d old)`);
  if (candidates.length > MAX_LISTED_NAMES) shown.push(`…and ${candidates.length - MAX_LISTED_NAMES} more`);
  return shown;
}

/** The sentence that keeps `dir_bytes` from being read as this directory's size. */
const DIR_BYTES_CAVEAT =
  '`list_backups` reports `dir_bytes` over library-backup files and their sidecars alone; '
  + '`directory_bytes` above is this tool\'s own lstat measurement of every regular file in the directory, '
  + 'so the two answer different questions and `directory_bytes` is never smaller.';

export function registerBackupCleanupTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'clean_backup_artifacts',
    'Delete the NON-library files sharing SPOTIFY_MCP_BACKUP_DIR with your library backups: closed listening sessions '
      + '(`listening-session-*.json`), playlist write pre-images (`playlistops-pre-*.json`) and legacy or migrated '
      + 'playback bookmarks (`playback-bookmark-*.json`). Library backups and their `.meta.json` sidecars are never '
      + 'touched — use `delete_backup`, and naming one here is refused. These files are local and gone for good once '
      + 'deleted. Preview by default; executing is confirmation-gated and refused when the client cannot prompt '
      + '(SPOTIFY_MCP_CONFIRM=never bypasses). Ages are mtimes, and the default window is '
      + 'SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS — separate from the library window. Unrecognised files are listed, '
      + 'not deleted.',
    {
      family: FamilyArg,
      older_than_days: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Age floor in days. 0 = no age filter. Omit to use the retention window.'),
      files: z
        .array(z.string().min(1))
        .optional()
        .describe('File names to delete instead of a sweep. Each must be inside the backup directory and match a known family; `family` and `older_than_days` then do not apply.'),
      response_format: ResponseFormat,
      dry_run: DryRunDefault,
    },
    async (args) => {
      const dir = backupDir();
      const rf = args.response_format;
      const now = Date.now();
      const inventory = await inventoryDirectory(dir, now);

      // The library-backup figure is taken from the SAME helper `list_backups`
      // uses, so the two tools cannot disagree about it. `directoryBytes` is
      // this tool's own whole-directory measurement, and the two are reported
      // side by side precisely because neither is the other's number.
      const libraryBytes = storeEnvelope(await readStoreEntries(dir), 0).dir_bytes;

      // `older_than_days` omitted means "use the window"; 0 is an explicit
      // "age is no filter". Those two can produce the same number, so which
      // one decided the selection is reported rather than left to inference.
      const mode = args.files !== undefined ? 'names' : 'sweep';
      const floor = args.older_than_days ?? backupArtifactRetentionDays();
      const ageSource = args.older_than_days === undefined
        ? 'SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS'
        : 'older_than_days';

      // Explicit names bypass the sweep. Each is confined by the shared
      // resolver BEFORE anything is matched, so a `..` segment, an absolute
      // path elsewhere, or a symlink planted under a family name is refused
      // on the real path rather than after the fact (#622/#697).
      let selected: Candidate[];
      if (args.files !== undefined) {
        const named: Candidate[] = [];
        for (const raw of args.files) {
          const requested = raw.trim();
          let resolved: { file: string };
          try {
            resolved = await resolveOutputPath({
              root: dir, target: requested, tool: 'clean_backup_artifacts', kind: 'file', overwrite: true,
            });
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const message = `clean_backup_artifacts: "${requested}" is not inside the backup directory (${dir}); nothing was deleted. ${detail}`;
            return shapeResult(rf, message, { ok: false, reason: 'refused', dir, requested, error: message, detail });
          }
          const name = basename(resolved.file);
          if (BACKUP_FILE_RE.test(name) || isLibrarySidecar(name)) {
            const message = `clean_backup_artifacts: "${name}" is a library backup (or its metadata sidecar), which this tool does not delete. Use delete_backup, which owns library snapshots and removes the sidecar with them. Nothing was deleted.`;
            return shapeResult(rf, message, { ok: false, reason: 'is_a_library_backup', dir, path: resolved.file, use: 'delete_backup', error: message });
          }
          const family = familyOf(name);
          if (family === null) {
            const message = `clean_backup_artifacts: "${name}" is not one of the non-library families this tool knows (${FAMILIES.map((f) => f.key).join(', ')}), and this tool does not delete files it cannot name. Nothing was deleted.`;
            return shapeResult(rf, message, { ok: false, reason: 'not_a_cleanup_target', dir, path: resolved.file, error: message });
          }
          const st = await lstat(resolved.file).catch(() => null);
          if (!st?.isFile()) {
            const message = `clean_backup_artifacts: no regular file at "${resolved.file}".`;
            return shapeResult(rf, message, { ok: false, reason: 'not_found', dir, path: resolved.file, error: message });
          }
          named.push({
            name, path: resolved.file, family: family.key, label: family.label, bytes: st.size,
            ageDays: Math.max(0, (now - st.mtimeMs) / DAY_MS),
          });
        }
        selected = named;
      } else {
        const wanted = args.family ?? 'all';
        // `0` means two different things depending on where it came from, and
        // conflating them would make `SPOTIFY_MCP_BACKUP_ARTIFACT_RETENTION_DAYS=0`
        // the most destructive setting in the file rather than the safest. From
        // the environment it means "expiry is switched off", so nothing is
        // selected; typed as `older_than_days: 0` it means "no age filter", so
        // everything is. Same number, opposite intent, so the source decides.
        const expiryEnabled = args.older_than_days !== undefined || floor > 0;
        selected = expiryEnabled
          ? inventory.candidates.filter(
            (c) => (wanted === 'all' || c.family === wanted) && c.ageDays >= floor,
          )
          : [];
      }

      const totalBytes = selected.reduce((sum, c) => sum + c.bytes, 0);

      const untouched: string[] = [
        `${inventory.libraryBackups.length} library backup(s) + ${inventory.librarySidecars.length} sidecar(s) untouched — delete_backup owns those`,
      ];
      if (inventory.unrecognised.length > 0) {
        untouched.push(`${inventory.unrecognised.length} unrecognised file(s) left alone: ${inventory.unrecognised.map((u) => u.name).slice(0, MAX_LISTED_NAMES).join(', ')}${inventory.unrecognised.length > MAX_LISTED_NAMES ? ', …' : ''}`);
      }
      if (inventory.notRegular.length > 0) {
        untouched.push(`${inventory.notRegular.length} non-regular entr(ies) skipped (symlink, directory or device): ${inventory.notRegular.slice(0, MAX_LISTED_NAMES).join(', ')}`);
      }

      const base: Record<string, unknown> = {
        dir,
        mode,
        family: args.family ?? 'all',
        retention_days: floor,
        retention_source: ageSource,
        expiry_enabled: args.older_than_days !== undefined || floor > 0,
        age_source: 'mtime',
        selected: selected.length,
        selected_bytes: totalBytes,
        candidates_available: inventory.candidates.length,
        library_backup_count: inventory.libraryBackups.length,
        library_backup_bytes: libraryBytes,
        library_sidecar_count: inventory.librarySidecars.length,
        directory_bytes: inventory.directoryBytes,
        unrecognised: inventory.unrecognised.map((u) => u.name),
        not_regular: inventory.notRegular,
        dir_bytes_caveat: DIR_BYTES_CAVEAT,
        untouched,
      };

      if (selected.length === 0) {
        const message = `No non-library backup artifacts matched under ${dir} — nothing to delete. ${untouched.join('. ')}. ${DIR_BYTES_CAVEAT}`;
        return shapeResult(rf, message, { ...base, ok: true, dry_run: isDryRun(args), deleted: 0 });
      }

      const changes = [
        `Delete ${selected.length} file(s) permanently, ${formatBytes(totalBytes)}:`,
        ...nameList(selected).map((line) => `  ${line}`),
        ...untouched,
      ];

      if (isDryRun(args)) {
        const payload = { ...base, ok: true, dry_run: true, files: selected.map((c) => ({ name: c.name, family: c.family, bytes: c.bytes, age_days: Number(c.ageDays.toFixed(2)) })) };
        return shapeResult(
          rf,
          `${describeDryRun('clean backup artifacts', mode === 'names' ? 'the named files' : `a ${base.family} sweep`, changes)}\n`
            + `${familySummary(selected).join('; ') || 'no families matched'}. ${untouched.join('. ')}. ${DIR_BYTES_CAVEAT}\n`
            + 'Re-run with dry_run: false to delete.',
          payload,
        );
      }

      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('clean backup artifacts', mode === 'names' ? `${selected.length} named file(s)` : `a ${base.family} sweep older than ${floor} day(s)`, changes),
        confirmLabel: 'Delete artifacts',
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return shapeResult(rf, refusal.message, refusal.payload);

      const deleted: string[] = [];
      const failed: string[] = [];
      for (const candidate of selected) {
        try {
          await unlink(candidate.path);
          deleted.push(candidate.name);
        } catch (error) {
          failed.push(`${candidate.name}: ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}`);
        }
      }
      const after = await inventoryDirectory(dir, Date.now());
      const message = `Deleted ${deleted.length} of ${selected.length} non-library backup artifact(s), ${formatBytes(totalBytes - selected.filter((c) => failed.some((f) => f.startsWith(`${c.name}:`))).reduce((s, c) => s + c.bytes, 0))} freed.`
        + `${failed.length > 0 ? ` Failed: ${failed.join('; ')}.` : ''}`
        + ` ${untouched.join('. ')}.`
        + ` Directory now ${formatBytes(after.directoryBytes)} across ${after.libraryBackups.length} library backup(s) — list_backups' dir_bytes will report ${formatBytes(libraryBytes)} of that, counting library files alone. ${DIR_BYTES_CAVEAT}`;
      return shapeResult(rf, message, {
        ...base,
        ok: failed.length === 0,
        dry_run: false,
        deleted: deleted.length,
        deleted_files: deleted,
        failed,
        directory_bytes_after: after.directoryBytes,
      });
    },
  );
}
