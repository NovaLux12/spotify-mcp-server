/**
 * Undo for receipt-driven mutations (#217).
 * Inverts the most recent (or a targeted) receipt's mutation.
 * Undo itself issues a new receipt so the agent gets proof of the rollback.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { verifyReceipt, issueReceipt, formatReceipt, getAllReceipts } from '../receipts.js';
import { DryRun, ResponseFormat } from '../shaping.js';

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) };
}

function reversibleKind(kind: string): boolean {
  return kind === 'playlist_items' || kind === 'library';
}

async function invertReceipt(
  client: SpotifyClient,
  receipt: NonNullable<ReturnType<typeof verifyReceipt>>,
  dryRun: boolean | undefined,
): Promise<ToolResult> {
  const uris = receipt.uris;
  if (!uris || uris.length === 0) {
    return textResult(`Receipt ${receipt.receipt_id} has no stored URIs — cannot undo.`, { ok: false, reason: 'no_uris' });
  }
  if (dryRun) {
    const lines = [`[dry run] undo ${receipt.receipt_id} (${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}) — nothing was changed.`, `Would invert ${uris.length} URI(s):`];
    for (const u of uris.slice(0, 10)) lines.push(`  - ${u}`);
    if (uris.length > 10) lines.push(`  (…and ${uris.length - 10} more)`);
    return textResult(lines.join('\n'), { ok: true, dry_run: true, receipt_id: receipt.receipt_id, kind: receipt.kind, uris });
  }
  let snapshotId: string | undefined;
  if (receipt.kind === 'playlist_items' && receipt.id) {
    try {
      const res = await client.delete<{ snapshot_id?: string }>(`/playlists/${encodeURIComponent(receipt.id)}/items`, { tracks: uris.map((uri) => ({ uri })) });
      snapshotId = res?.snapshot_id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return textResult(`Undo failed: ${msg}`, { ok: false, error: msg });
    }
  } else if (receipt.kind === 'library') {
    try {
      // Library undo: try remove then save fallback — default to remove (undo a save)
      await client.delete(`/me/library?uris=${uris.join(',')}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return textResult(`Undo failed: ${msg}`, { ok: false, error: msg });
    }
  }
  let newReceipt;
  try {
    newReceipt = await issueReceipt(client, { kind: receipt.kind, id: receipt.id, uris, expectPresent: false });
  } catch { /* best-effort */ }
  const lines = [`Undid ${receipt.receipt_id} (${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}) — inverted ${uris.length} URI(s).`];
  if (snapshotId) lines.push(`Snapshot ID: ${snapshotId}`);
  if (newReceipt) lines.push(formatReceipt(newReceipt, { expectPresent: false }));
  return textResult(lines.join('\n'), { ok: true, undone_receipt: receipt.receipt_id, snapshot_id: snapshotId, receipt: newReceipt as unknown as Record<string, unknown> });
}

export function registerUndoTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'undo_mutation',
    'Undo a specific mutation by receipt ID. Inverts: playlist_items add→remove, library save→remove. Non-reversible kinds return not reversible. Supports dry_run.',
    {
      receipt_id: z.string().min(1).describe('Receipt ID to undo'),
      response_format: ResponseFormat,
      dry_run: DryRun,
    },
    async (args) => {
      const receipt = verifyReceipt(args.receipt_id);
      if (!receipt) return textResult(`Unknown receipt "${args.receipt_id}" — receipts are kept for the most recent 100 mutations.`, { ok: false, reason: 'unknown_receipt' });
      if (!reversibleKind(receipt.kind)) return textResult(`Receipt ${receipt.receipt_id} (kind ${receipt.kind}) is not reversible.`, { ok: false, reason: 'not_reversible', kind: receipt.kind });
      return invertReceipt(client, receipt, args.dry_run as boolean | undefined);
    },
  );

  server.tool(
    'undo_last_mutation',
    'Undo the most recent reversible mutation (receipt FIFO). Same inversion semantics as undo_mutation. Supports dry_run.',
    { dry_run: DryRun,
      response_format: ResponseFormat, },
    async (args) => {
      const all = getAllReceipts();
      let target: ReturnType<typeof verifyReceipt> | undefined;
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i]!;
        if (reversibleKind(r.kind) && r.uris.length > 0) { target = r; break; }
      }
      if (!target) return textResult('No reversible mutation found in recent receipts.', { ok: false, reason: 'no_reversible' });
      return invertReceipt(client, target, args.dry_run as boolean | undefined);
    },
  );
}
