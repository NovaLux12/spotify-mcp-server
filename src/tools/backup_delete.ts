/**
 * `delete_backup` — the one destructive tool in the library backup family
 * (#1017), split out of backup.ts so the manifest can give it its own row.
 *
 * It removes a local snapshot file and its sidecar; it never mutates Spotify.
 * The split exists because `readOnlySafe` is a per-registrar-row flag: while
 * delete_backup shared backup.ts's row, closing the read-only hole (flipping
 * the flag) also hid `list_backups` and `backup_library` from every
 * SPOTIFY_MCP_READONLY session — a read-only user lost the ability to inspect
 * their own backups. One row per safety class fixes both directions.
 */
import { z } from 'zod';
import { stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { ResponseFormat, DryRun, describeDryRun } from '../shaping.js';
import { backupRetentionDays, resolveOutputPath } from '../paths.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import {
  BACKUP_FILE_RE,
  backupDir,
  describeEnvelope,
  formatBytes,
  metadataSidecarPath,
  readStoreEntries,
  shapeResult,
  storeEnvelope,
} from './backup.js';

/**
 * delete_backup is opt-OUT of preview (#627): the schema itself advertises
 * the safe default, so a client that inspects the signature — rather than
 * reading the prose — sees that a missing dry_run means "delete nothing".
 */
const DeleteDryRun = DryRun.default(true).describe(
  'Preview only, and the default: pass dry_run: false to delete the snapshot.',
);

export function registerBackupDeleteTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'delete_backup',
    'Delete one library backup file (and its metadata sidecar) from SPOTIFY_MCP_BACKUP_DIR. Irreversible — the library rows in the file cannot be recovered from anywhere else. Destructive and confirmation-gated: dry_run defaults to true, and executing is refused when the client cannot prompt (SPOTIFY_MCP_CONFIRM=never bypasses). Paths outside the backup directory are refused.',
    {
      file: z.string().min(1).describe('Backup file name (e.g. backup-2026-01-02-1.json) or a path inside the backup directory'),
      response_format: ResponseFormat,
      dry_run: DeleteDryRun,
    },
    async (args) => {
      const dir = backupDir();
      const requested = args.file.trim();
      // Confinement is decided on the REAL path by the shared resolver: a
      // `..` segment, an absolute path elsewhere, or a symlink planted
      // under a backup name all resolve first and are refused outside the
      // store (#622/#697).
      let resolved: { file: string };
      try {
        resolved = await resolveOutputPath({
          root: dir,
          target: requested,
          tool: 'delete_backup',
          kind: 'file',
          overwrite: true,
        });
      } catch (error) {
        // The shared resolver's own wording is about writing exports; the
        // leading sentence says what the caller actually asked for, and the
        // resolver's line stays as the reason.
        const detail = error instanceof Error ? error.message : String(error);
        const message = `delete_backup: "${requested}" is not inside the backup directory (${dir}); nothing was deleted. ${detail}`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'refused', dir, requested, error: message, detail },
        );
      }
      const name = basename(resolved.file);
      if (!BACKUP_FILE_RE.test(name)) {
        const message = `delete_backup: "${name}" is not a library backup file (expected backup-YYYY-MM-DD-N[.partial].json).`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'not_a_backup', dir, path: resolved.file, error: message },
        );
      }
      const st = await stat(resolved.file).catch(() => null);
      if (!st?.isFile()) {
        const message = `delete_backup: no readable backup file at "${resolved.file}".`;
        return shapeResult(
          args.response_format,
          message,
          { ok: false, reason: 'not_found', dir, path: resolved.file, error: message },
        );
      }
      const sidecarPath = metadataSidecarPath(resolved.file);
      const sidecar = await stat(sidecarPath).catch(() => null);
      const sidecarBytes = sidecar?.isFile() ? sidecar.size : 0;
      const changes = [
        `Delete ${resolved.file} (${formatBytes(st.size)}) permanently — those library rows exist nowhere else`,
        ...(sidecarBytes > 0 ? [`Delete its metadata sidecar (${formatBytes(sidecarBytes)})`] : []),
      ];

      if (args.dry_run !== false) {
        const payload: Record<string, unknown> = {
          ok: true,
          dry_run: true,
          dir,
          path: resolved.file,
          bytes: st.size,
          sidecar: sidecarBytes > 0 ? sidecarPath : null,
          sidecar_bytes: sidecarBytes,
          retention_days: backupRetentionDays(),
        };
        return shapeResult(args.response_format, `${describeDryRun('delete backup', name, changes)}\nRe-run with dry_run: false to delete.`, payload);
      }

      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation('delete backup', name, changes),
        confirmLabel: 'Delete backup',
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return shapeResult(args.response_format, refusal.message, refusal.payload);

      try {
        await unlink(resolved.file);
      } catch (error) {
        const message = `delete_backup: could not delete "${resolved.file}": ${(error as NodeJS.ErrnoException).code ?? 'unknown error'}.`;
        return shapeResult(args.response_format, message, { ok: false, reason: 'delete_failed', dir, path: resolved.file, error: message });
      }
      let sidecarDeleted = false;
      if (sidecarBytes > 0) {
        try {
          await unlink(sidecarPath);
          sidecarDeleted = true;
        } catch {
          sidecarDeleted = false;
        }
      }
      return shapeResult(
        args.response_format,
        `Deleted backup ${resolved.file} (${formatBytes(st.size)})${sidecarDeleted ? ' and its metadata sidecar' : ''}. ${describeEnvelope(storeEnvelope(await readStoreEntries(dir), backupRetentionDays()), backupRetentionDays())}`,
        {
          ok: true,
          deleted: true,
          dry_run: false,
          dir,
          path: resolved.file,
          bytes: st.size,
          sidecar_deleted: sidecarDeleted,
          retention_days: backupRetentionDays(),
        },
      );
    },
  );
}
