/**
 * Undo for receipt-driven mutations (#217, #625).
 * Inverts the most recent (or a targeted) receipt's mutation, using the direction
 * the receipt recorded: an `added` receipt is undone by removing, a `removed`
 * receipt by re-adding. Undo itself issues a new receipt so the agent gets proof
 * of the rollback, and it previews by default (`dry_run: false` executes).
 *
 * Executing an undo is a destructive write, not a repair tool: it removes real
 * library/playlist rows (#627). It therefore goes through the same
 * requiredConfirmationRefusal gate as the other destructive families, which
 * fails closed when the client cannot prompt. The dry-run default lives here
 * rather than in the shared `DryRun` shape, which every other tool reads as
 * opt-in preview.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  confirmViaElicitation,
  describeConfirmation,
  requiredConfirmationRefusal,
} from './confirm.js';
import type { SpotifyClient } from '../client.js';
import {
  verifyReceipt,
  issueReceipt,
  formatReceipt,
  getAllReceipts,
  type Receipt,
} from '../receipts.js';
import { DryRun, ResponseFormat } from '../shaping.js';

/**
 * Undo is opt-OUT of preview (#627): the schema itself advertises the safe
 * default, so a client that inspects the tool signature — rather than reading
 * the prose — sees that a missing dry_run means "do nothing".
 */
const UndoDryRun = DryRun.default(true).describe(
  'Preview only, and the default: pass dry_run: false to execute the rollback.',
);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };

function textResult(text: string, s?: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) };
}

/** Spotify write caps: 100 items per playlist request, 40 per unified-library request. */
const PLAYLIST_ITEMS_CHUNK = 100;
const LIBRARY_CHUNK = 40;

function reversibleKind(kind: string): boolean {
  return kind === 'playlist_items' || kind === 'library';
}

/** Split into fixed-size chunks for the API's per-request caps. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Human-readable target for the confirmation prompt. */
function undoTarget(receipt: Receipt): string {
  if (receipt.kind === 'library') return 'your library';
  return receipt.id ? `playlist ${receipt.id}` : receipt.kind;
}

/**
 * Undo a receipt by performing the opposite of its recorded direction.
 * `receipt.direction` is absent only on receipts issued before #625; those were
 * overwhelmingly add/save receipts, so `added` is the conservative default
 * (undoing an add by removing is recoverable; re-adding duplicates is not).
 */
async function invertReceipt(
  server: McpServer,
  client: SpotifyClient,
  receipt: Receipt,
  dryRun: boolean | undefined,
): Promise<ToolResult> {
  const uris = receipt.uris;
  if (!uris || uris.length === 0) {
    return textResult(`Receipt ${receipt.receipt_id} has no stored URIs — cannot undo.`, { ok: false, reason: 'no_uris' });
  }
  const direction = receipt.direction ?? 'added';
  const inverse = direction === 'added' ? 'remove' : 'add';

  // Preview unless the caller explicitly asked to execute (#625: undo defaults to dry-run,
  // matching restore_library_snapshot).
  if (dryRun !== false) {
    const lines = [
      `[dry run] undo ${receipt.receipt_id} (${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}) — nothing was changed.`,
      `Original mutation: ${direction}. Would ${inverse} ${uris.length} URI(s):`,
    ];
    for (const u of uris.slice(0, 10)) lines.push(`  - ${u}`);
    if (uris.length > 10) lines.push(`  (…and ${uris.length - 10} more)`);
    lines.push('Re-run with dry_run: false to execute.');
    return textResult(lines.join('\n'), {
      ok: true, dry_run: true, receipt_id: receipt.receipt_id, kind: receipt.kind,
      direction, would: inverse, uris,
    });
  }

  // Executing is the destructive half: the preview above touches nothing, but
  // this block deletes real library/playlist rows. Ask first, and refuse
  // outright when the client never advertised elicitation (#627) — an
  // unanswerable prompt must not become an unprompted rollback.
  const verdict = await confirmViaElicitation(server, {
    message: describeConfirmation('undo mutation', undoTarget(receipt), [
      `Reverse receipt ${receipt.receipt_id} (${direction} → ${inverse}) over ${uris.length} URI(s):`,
      ...uris.slice(0, 10),
      ...(uris.length > 10 ? [`(…and ${uris.length - 10} more)`] : []),
    ]),
  });
  const refusal = requiredConfirmationRefusal(verdict);
  if (refusal) return textResult(refusal.message, refusal.payload);

  let snapshotId: string | undefined;
  let requests = 0;
  let attemptedRequests = 0;
  try {
    if (receipt.kind === 'playlist_items' && receipt.id) {
      const encId = encodeURIComponent(receipt.id);
      for (const part of chunk(uris, PLAYLIST_ITEMS_CHUNK)) {
        attemptedRequests++;
        if (direction === 'added') {
          const res = await client.delete<{ snapshot_id?: string }>(`/playlists/${encId}/items`, {
            tracks: part.map((uri) => ({ uri })),
          });
          snapshotId = res?.snapshot_id ?? snapshotId;
        } else {
          const res = await client.post<{ snapshot_id?: string }>(`/playlists/${encId}/items`, { uris: part });
          snapshotId = res?.snapshot_id ?? snapshotId;
        }
        requests++;
      }
    } else if (receipt.kind === 'library') {
      for (const part of chunk(uris, LIBRARY_CHUNK)) {
        const qs = `uris=${part.join(',')}`;
        attemptedRequests++;
        if (direction === 'added') await client.delete(`/me/library?${qs}`);
        else await client.put(`/me/library?${qs}`);
        requests++;
      }
    }
  } catch {
    if (attemptedRequests === 0) throw new Error('Undo could not start.');
    return textResult('Undo stopped after a partial write; verify the current library or playlist state before retrying.', {
      ok: false,
      reason: 'partial_write_failure',
      direction,
      completed_requests: requests,
      attempted_requests: attemptedRequests,
    });
  }

  let newReceipt: Receipt | undefined;
  try {
    // After undoing an add the URIs are absent; after undoing a removal they are present.
    newReceipt = await issueReceipt(client, {
      kind: receipt.kind, id: receipt.id, uris,
      expectPresent: direction === 'removed',
    });
  } catch { /* best-effort */ }

  const lines = [
    `Undid ${receipt.receipt_id} (${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}) — ${direction} → ${inverse}, ${uris.length} URI(s) across ${requests} request(s).`,
  ];
  if (snapshotId) lines.push(`Snapshot ID: ${snapshotId}`);
  if (newReceipt) lines.push(formatReceipt(newReceipt, { expectPresent: direction === 'removed' }));
  return textResult(lines.join('\n'), {
    ok: true, undone_receipt: receipt.receipt_id, direction, inverted_to: inverse,
    requests, snapshot_id: snapshotId, receipt: newReceipt as unknown as Record<string, unknown>,
  });
}

export function registerUndoTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'undo_mutation',
    'Undo a specific mutation by receipt ID. Inverts the recorded direction: an add/save is undone by removing, a removal by re-adding (playlist items or library). Non-reversible kinds return not reversible. Executing needs confirmation and is refused when the client cannot prompt (SPOTIFY_MCP_CONFIRM=never bypasses).',
    {
      receipt_id: z.string().min(1).describe('Receipt ID to undo'),
      response_format: ResponseFormat,
      dry_run: UndoDryRun,
    },
    async (args) => {
      const receipt = verifyReceipt(args.receipt_id);
      if (!receipt) return textResult(`Unknown receipt "${args.receipt_id}" — receipts are kept for the most recent 100 mutations.`, { ok: false, reason: 'unknown_receipt' });
      if (!reversibleKind(receipt.kind)) return textResult(`Receipt ${receipt.receipt_id} (kind ${receipt.kind}) is not reversible.`, { ok: false, reason: 'not_reversible', kind: receipt.kind });
      return invertReceipt(server, client, receipt, args.dry_run as boolean | undefined);
    },
  );

  server.tool(
    'undo_last_mutation',
    'Undo the most recent reversible mutation (receipt FIFO). Same inversion semantics as undo_mutation: add/save → remove, removal → re-add. Executing needs confirmation and is refused when the client cannot prompt (SPOTIFY_MCP_CONFIRM=never bypasses).',
    { dry_run: UndoDryRun,
      response_format: ResponseFormat, },
    async (args) => {
      const all = getAllReceipts();
      let target: Receipt | undefined;
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i]!;
        if (reversibleKind(r.kind) && r.uris.length > 0) { target = r; break; }
      }
      if (!target) return textResult('No reversible mutation found in recent receipts.', { ok: false, reason: 'no_reversible' });
      return invertReceipt(server, client, target, args.dry_run as boolean | undefined);
    },
  );
}
