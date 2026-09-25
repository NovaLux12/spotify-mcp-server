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
import { DryRun, ResponseFormat, LIBRARY_WRITE_CHUNK } from '../shaping.js';

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

/** Spotify write caps: 100 items per playlist request; `/me/library` uses the
 * canonical `LIBRARY_WRITE_CHUNK` (40) from shaping.ts. */
const PLAYLIST_ITEMS_CHUNK = 100;

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
 * The exact playlist rows an add created, as `{uri, position}` pairs (#625).
 *
 * `DELETE /playlists/{id}/items` with a bare `{uri}` entry removes EVERY
 * occurrence of that URI, so undoing an add that duplicated an existing track
 * would also delete the row that predated the mutation. The receipt records
 * the occurrence each add created, so undo targets those rows.
 *
 * Returns null when the receipt does not account for every recorded URI —
 * receipts written before #625, and adds whose rows fell outside the
 * verification window. The caller then refuses rather than guessing.
 */
function targetedRemovals(
  receipt: Receipt,
): Array<{ uri: string; position: number }> | null {
  if (receipt.affected === undefined || receipt.affected.length === 0) return null;
  const recorded = new Set(receipt.affected.map((entry) => entry.uri));
  if (receipt.uris.some((uri) => !recorded.has(uri))) return null;
  const pairs: Array<{ uri: string; position: number }> = [];
  for (const entry of receipt.affected) {
    for (const position of entry.positions) pairs.push({ uri: entry.uri, position });
  }
  return pairs;
}

/**
 * Split ascending positions into runs of adjacent indices, so re-inserting a
 * removed block costs one write per block rather than one per row. A run is
 * inserted at its first index and lands in the given order; a run past the
 * per-request cap is split, the later parts resuming 100 indices later.
 */
function consecutiveRuns(
  pairs: Array<{ uri: string; position: number }>,
): Array<Array<{ uri: string; position: number }>> {
  const runs: Array<Array<{ uri: string; position: number }>> = [];
  for (const pair of pairs) {
    const run = runs[runs.length - 1];
    const previous = run?.[run.length - 1];
    if (previous && pair.position === previous.position + 1) run.push(pair);
    else runs.push([pair]);
  }
  return runs;
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
  // A receipt written before #625 carries no direction. Those were
  // overwhelmingly add/save receipts, so `added` is the conservative default
  // (undoing an add by removing is recoverable; re-adding duplicates is not) —
  // but it is an ASSUMPTION, so it is labelled as one in every result (#625).
  const directionAssumed = receipt.direction === undefined;
  const direction = receipt.direction ?? 'added';
  const inverse = direction === 'added' ? 'remove' : 'add';
  const expectPresentAfter = direction === 'removed';

  // Preview unless the caller explicitly asked to execute (#625: undo defaults to dry-run,
  // matching restore_library_snapshot).
  if (dryRun !== false) {
    const lines = [
      `[dry run] undo ${receipt.receipt_id} (${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}) — nothing was changed.`,
      `Original mutation: ${direction}. Would ${inverse} ${uris.length} URI(s):`,
    ];
    for (const u of uris.slice(0, 10)) lines.push(`  - ${u}`);
    if (uris.length > 10) lines.push(`  (…and ${uris.length - 10} more)`);
    if (directionAssumed) {
      lines.push('NOTE: this receipt predates direction tracking — "added" is assumed, not recorded.');
    }
    if (receipt.kind === 'playlist_items' && direction === 'added') {
      const removals = targetedRemovals(receipt);
      lines.push(
        removals
          ? `Targeted at the ${removals.length} recorded row(s) the add created; other copies of these URIs are left alone.`
          : 'REFUSED at execute time: the receipt records no row positions, and a bare-URI delete would remove every copy of each URI.',
      );
    }
    lines.push('Re-run with dry_run: false to execute.');
    return textResult(lines.join('\n'), {
      ok: true, dry_run: true, receipt_id: receipt.receipt_id, kind: receipt.kind,
      ...(directionAssumed ? { direction_assumed: true as const } : {}),
      direction, would: inverse, uris,
    });
  }

  // Decide whether this undo is even possible BEFORE asking the user to
  // confirm it: a prompt for a rollback that then refuses wastes the user's
  // attention, and a client that cannot prompt would report the wrong reason.
  const rows = receipt.kind === 'playlist_items' ? targetedRemovals(receipt) : [];
  if (receipt.kind === 'playlist_items' && direction === 'added' && rows === null) {
    return textResult(
      `Refusing to undo ${receipt.receipt_id}: the receipt does not record which playlist rows the add created. ` +
        `A bare-URI delete removes EVERY occurrence of each URI, which would also delete rows that existed before the add. ` +
        `No write was made — remove the intended rows explicitly instead.`,
      {
        ok: false,
        reason: 'occurrences_unrecorded',
        receipt_id: receipt.receipt_id,
        kind: receipt.kind,
        id: receipt.id,
        ...(directionAssumed ? { direction_assumed: true as const } : {}),
      },
    );
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
  // The playlist rows THIS undo created, which the post-state receipt is told
  // explicitly. A rollback's write shape cannot be re-derived from the list
  // afterwards: a delete-only undo created nothing, and a re-insert put rows
  // back at indices the append rule would never guess (#625).
  let createdPositions: Array<{ uri: string; position: number }> | undefined;
  try {
    if (receipt.kind === 'playlist_items' && receipt.id) {
      const encId = encodeURIComponent(receipt.id);
      if (direction === 'added') {
        // Undo of an add removes exactly the rows the add created (#625) —
        // never every copy of the URI. `rows` is non-null here: the refusal
        // above already returned for the unrecorded case.
        //
        // The delete body is `{ tracks: [{ uri, positions: [n] }] }` — the
        // shape every other call site in this repo sends (playlists.ts,
        // playlistbatch.ts, swarm3_playlistops.ts, swarm3_snapshots.ts) and
        // the shape the endpoint documents. A top-level `uris`/`positions`
        // pair is NOT accepted here and 400s.
        //
        // Row indices are positions in a list that shrinks with every request,
        // so the removals go lowest-first and each chunk is translated by the
        // rows the previous chunks already deleted.
        const ordered = [...rows!].sort((a, b) => a.position - b.position);
        let removedSoFar = 0;
        for (const part of chunk(ordered, PLAYLIST_ITEMS_CHUNK)) {
          attemptedRequests++;
          const res = await client.delete<{ snapshot_id?: string }>(`/playlists/${encId}/items`, {
            tracks: part.map((p) => ({ uri: p.uri, positions: [p.position - removedSoFar] })),
          });
          snapshotId = res?.snapshot_id ?? snapshotId;
          requests++;
          removedSoFar += part.length;
        }
        // This rollback only DELETED rows. Every copy that survives predates
        // it, so the receipt must claim no created rows — otherwise the next
        // undo reads a survivor as this mutation's own and deletes it.
        createdPositions = [];
      } else if (rows !== null && rows.length > 0) {
        // Undo of a positions-targeted removal puts each row back where it
        // was. `POST /playlists/{id}/items` takes a zero-based `position`
        // (the same parameter `add_to_playlist` exposes); rows are re-inserted
        // lowest-first, so every target index still holds the row that
        // preceded it. Runs of adjacent positions share one write, itself
        // split when it exceeds the API's per-request cap.
        const ordered = [...rows].sort((a, b) => a.position - b.position);
        const created: Array<{ uri: string; position: number }> = [];
        // Spotify caps one playlist write at `PLAYLIST_ITEMS_CHUNK` uris. A run
        // longer than that — reachable because `remove_from_playlist` caps
        // `uris` ENTRIES, not the `positions` inside one entry — must be split:
        // an oversized request is rejected and the rollback restores nothing.
        // Sub-request k resumes at the index the earlier ones already filled.
        for (const run of consecutiveRuns(ordered)) {
          for (const [k, part] of chunk(run, PLAYLIST_ITEMS_CHUNK).entries()) {
            const at = run[0]!.position + k * PLAYLIST_ITEMS_CHUNK;
            attemptedRequests++;
            const res = await client.post<{ snapshot_id?: string }>(`/playlists/${encId}/items`, {
              uris: part.map((p) => p.uri),
              position: at,
            });
            snapshotId = res?.snapshot_id ?? snapshotId;
            requests++;
            // The rows this sub-request created occupy `at` onwards: the removal
            // left a gap exactly this long there, and rows go back lowest-first
            // so no later insert shifts them.
            part.forEach((p, i) => created.push({ uri: p.uri, position: at + i }));
          }
        }
        createdPositions = created;
      } else {
        // A removal with no recorded positions: re-add and append, which is
        // the strongest guarantee the receipt supports.
        for (const part of chunk(uris, PLAYLIST_ITEMS_CHUNK)) {
          attemptedRequests++;
          const res = await client.post<{ snapshot_id?: string }>(`/playlists/${encId}/items`, { uris: part });
          snapshotId = res?.snapshot_id ?? snapshotId;
          requests++;
        }
      }
    } else if (receipt.kind === 'library') {
      for (const part of chunk(uris, LIBRARY_WRITE_CHUNK)) {
        // `LIBRARY_WRITE_CHUNK` is the documented 40-uri cap; URLSearchParams
        // keeps caller-supplied URIs from reshaping the query (#624).
        const qs = new URLSearchParams({ uris: part.join(',') }).toString();
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
      ...(directionAssumed ? { direction_assumed: true as const } : {}),
      completed_requests: requests,
      attempted_requests: attemptedRequests,
    });
  }

  // A uri that had copies PREDATING the mutation is still expected to be
  // present after its added row is removed — the rollback restores the
  // pre-mutation state, it does not make the uri vanish.
  //
  // The two groups are verified SEPARATELY. One `expectPresent` flag for the
  // whole set cannot express "X stays, Y goes": asking for presence puts Y in
  // `missing`, and asking for absence puts X there. Either way a correct
  // rollback is reported as unconfirmed, and the natural response to a check
  // that cries wolf is to delete it (#625).
  const retained = new Set<string>();
  if (direction === 'added' && receipt.occurrences) {
    const removedPerUri = new Map<string, number>();
    for (const pair of rows ?? []) {
      removedPerUri.set(pair.uri, (removedPerUri.get(pair.uri) ?? 0) + 1);
    }
    for (const [uri, removed] of removedPerUri) {
      if ((receipt.occurrences[uri] ?? 0) > removed) retained.add(uri);
    }
  }
  const stayUris = expectPresentAfter ? uris : uris.filter((u) => retained.has(u));
  const goUris = expectPresentAfter ? [] : uris.filter((u) => !retained.has(u));

  let stayReceipt: Receipt | undefined;
  let goReceipt: Receipt | undefined;
  if (stayUris.length > 0) {
    try {
      stayReceipt = await issueReceipt(client, {
        kind: receipt.kind, id: receipt.id, uris: stayUris, expectPresent: true,
        // Omitted for the append re-add, where the last-occurrence rule is
        // already the truth; stated for every other playlist shape so the
        // receipt never claims a row this undo did not create (#625).
        ...(createdPositions !== undefined ? { createdPositions } : {}),
      });
    } catch { /* best-effort */ }
  }
  if (goUris.length > 0) {
    try {
      goReceipt = await issueReceipt(client, {
        kind: receipt.kind, id: receipt.id, uris: goUris, expectPresent: false,
      });
    } catch { /* best-effort */ }
  }
  const newReceipt = goReceipt ?? stayReceipt;
  // Both groups must verify, and a group that could not be checked at all
  // leaves the rollback unconfirmed rather than assumed good.
  const checked = (stayUris.length === 0 || stayReceipt !== undefined)
    && (goUris.length === 0 || goReceipt !== undefined);
  const confirmed = checked
    && (stayReceipt === undefined || stayReceipt.verified)
    && (goReceipt === undefined || goReceipt.verified);

  // Report the OBSERVED post-state, never an assumed one (#625). A write that
  // did not produce the intended state is the case an agent most needs to see,
  // and "inverted N URI(s)" hides it behind a success the user would believe.
  // The prose states WHICH expectation was applied: a group verified by
  // expecting presence was not checked for absence, and saying "all uris are
  // present" would read as proof the added rows are gone when it is not.
  const target = `${receipt.kind}${receipt.id ? ` ${receipt.id}` : ''}`;
  const unconfirmed: string[] = [
    ...(stayReceipt?.verified === false ? stayReceipt.missing : []),
    ...(goReceipt?.verified === false ? goReceipt.missing : []),
  ];
  const lines: string[] = [];
  if (confirmed) {
    const checks: string[] = [];
    if (goUris.length > 0) checks.push(`${goUris.length} URI(s) confirmed absent`);
    if (stayUris.length > 0) checks.push(`${stayUris.length} URI(s) confirmed present`);
    lines.push(
      `Undid ${receipt.receipt_id} (${target}) — ${direction} → ${inverse}, ` +
        `${uris.length} URI(s) across ${requests} request(s). ` +
        `Post-state refetch: ${checks.join('; ')}.`,
    );
  } else if (unconfirmed.length > 0) {
    lines.push(
      `Undo of ${receipt.receipt_id} (${target}) issued ${requests} request(s) for ${uris.length} URI(s), ` +
        `but the post-state check did NOT confirm: ${unconfirmed.join(', ')}. ` +
        `The library/playlist may not match the state before ${receipt.receipt_id}; inspect it before retrying.`,
    );
  } else {
    lines.push(
      `Undo of ${receipt.receipt_id} (${target}) issued ${requests} request(s) for ${uris.length} URI(s), ` +
        `but the post-state check could not run, so the result is unconfirmed. ` +
        `Inspect the current state before retrying.`,
    );
  }
  if (retained.size > 0) {
    lines.push(
      `${retained.size} URI(s) had copies that predate ${receipt.receipt_id} and are expected to remain: ` +
        `${[...retained].join(', ')}. Their presence was checked; the rows the add created were removed by request, not by this refetch.`,
    );
  }
  if (directionAssumed) lines.push('NOTE: direction was assumed ("added") — this receipt predates direction tracking.');
  if (snapshotId) lines.push(`Snapshot ID: ${snapshotId}`);
  if (stayReceipt) lines.push(formatReceipt(stayReceipt, { expectPresent: true }));
  if (goReceipt) lines.push(formatReceipt(goReceipt, { expectPresent: false }));
  return textResult(lines.join('\n'), {
    ok: confirmed,
    undone_receipt: receipt.receipt_id,
    direction,
    ...(directionAssumed ? { direction_assumed: true as const } : {}),
    inverted_to: inverse,
    requests,
    verified: confirmed,
    expected_absent: goUris,
    expected_present: stayUris,
    ...(confirmed ? {} : { reason: unconfirmed.length > 0 ? 'post_state_mismatch' : 'post_state_unverified' }),
    ...(unconfirmed.length > 0 ? { unconfirmed_uris: unconfirmed } : {}),
    snapshot_id: snapshotId,
    receipt: (newReceipt ?? null) as unknown as Record<string, unknown>,
  });
}

export function registerUndoTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'undo_mutation',
    'Undo a specific mutation by receipt ID. Inverts the recorded direction: an add/save is undone by removing, a removal by re-adding (playlist items or library). A playlist add undo removes only the rows it created, refusing when no row positions are recorded. The result reflects the refetched post-state. Non-reversible kinds return not reversible. Executing needs confirmation and is refused when the client cannot prompt (SPOTIFY_MCP_CONFIRM=never bypasses).',
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
