/**
 * episodemgmt (#204, #187, #230): archive_played_episodes.
 * mark_episode_played was removed in #230 — PUT /me/episodes/{id} with
 * resume_point is not a real Spotify endpoint (real endpoint is
 * PUT /me/episodes?ids= to save). The tool swallowed 404s and reported
 * ok:true, which was phantom success. Removed per #85 precedent.
 */
import { z } from 'zod';
import { capFor } from '../chunk.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { formatReceipt, issueReceipt, type Receipt } from '../receipts.js';
import { DryRun, describeDryRun, ResponseFormat } from '../shaping.js';

/**
 * Above this many fully-played episodes the bulk archive asks a human through
 * elicitation (or the server-wide SPOTIFY_MCP_CONFIRM=never). Strictly greater
 * than: 50 itself is a single delete request, not a bulk operation.
 */
export const ARCHIVE_ELICIT_THRESHOLD = 50;



type EpisodeRow = {
  episode: { id: string; uri: string; name: string; resume_point?: { fully_played: boolean } };
  added_at: string;
};

/** Why a scan came back short, so a caller can tell a wall from a cap. */
type ScanFailure = 'walk_failed' | 'no_pager' | 'limit_reached';

/**
 * A read of the saved-episode library that knows whether it read all of it.
 *
 * `complete` is the whole point of this shape (#746). This tool is a
 * destructive bulk remover, so a scan it does not trust must never be reported
 * as a verdict nor turned into a deletion: the code below used to swallow the
 * library walk, fall back to one 50-item page, and tell the caller "No
 * fully-played episodes in library (scanned 50)" over a library it never read.
 * `scanned` is a library total only when `complete` is true.
 */
type EpisodeScan = {
  items: EpisodeRow[];
  scanned: number;
  complete: boolean;
  failure: ScanFailure | null;
  reason: string | null;
};

function describeScanError(err: unknown): string {
  const e = err as { message?: unknown; status?: unknown; retryAfterSec?: unknown } | null;
  const message = typeof e?.message === 'string' && e.message.trim() !== '' ? e.message : String(err);
  const status = typeof e?.status === 'number' ? ` (HTTP ${e.status})` : '';
  const retry = typeof e?.retryAfterSec === 'number' ? ` Retry-After: ${e.retryAfterSec}s.` : '';
  return `${message}${status}${retry}`;
}

/**
 * Read the saved-episode library, recording how much of it was actually read.
 *
 * The pager is asked for `cap + 1` rows on purpose: `getAllPages` stops at
 * `maxItems` and slices, so a library of exactly `cap` still returns `cap` and
 * reads as complete, while anything longer returns `cap + 1` and is reported
 * as partial. Without that off-by-one, "reached the requested limit" and "read
 * the whole library" are indistinguishable and the count silently becomes a
 * lie.
 */
async function scanSavedEpisodes(client: SpotifyClient, cap: number): Promise<EpisodeScan> {
  const pager = (client as Partial<SpotifyClient>).getAllPages;
  if (typeof pager !== 'function') {
    // A client that cannot page can only ever see one page. `total` rides in
    // that same response and is the server's own count of the library, so it is
    // an observation rather than a guess: when the page holds that many rows,
    // the read did cover the whole library, and calling it truncated would be
    // this tool asserting a fact about the library it never measured — and
    // refusing an archive it can actually vouch for. A client that omits
    // `total` leaves the tool unable to tell, and "I cannot tell" is the only
    // claim this branch is entitled to make.
    const res = await client.get<{ items?: EpisodeRow[]; total?: number }>('/me/episodes', {
      limit: String(Math.min(cap, 50)),
    });
    const items = Array.isArray(res?.items) ? res.items : [];
    const librarySize = typeof res?.total === 'number' && Number.isFinite(res.total) ? res.total : null;
    const readWholeLibrary = librarySize !== null && items.length >= librarySize;
    if (readWholeLibrary) {
      return { items, scanned: items.length, complete: true, failure: null, reason: null };
    }
    return {
      items,
      scanned: items.length,
      complete: false,
      failure: 'no_pager',
      reason: librarySize === null
        ? `this client cannot page through the library and its response carried no total, so this tool cannot tell whether the ${items.length} episode(s) it read are the whole library`
        : `this client cannot page through the library, so only the newest ${items.length} of the library's ${librarySize} saved episode(s) were read and the other ${librarySize - items.length} were never scanned`,
    };
  }
  try {
    const rows = await client.getAllPages<EpisodeRow>('/me/episodes', { limit: '50' }, { maxItems: cap + 1 });
    const items = Array.isArray(rows) ? rows : [];
    if (items.length > cap) {
      return {
        // The cap+1 row exists only to prove truncation. Keeping it would count
        // an episode this tool never claims to have read, and the partial report
        // would then say "51 found among the 50 read". Slice it off so the row
        // set and the count agree, as libraryhygiene.ts and import.ts do.
        items: items.slice(0, cap),
        scanned: cap,
        complete: false,
        failure: 'limit_reached',
        reason: `the scan stopped at the requested limit of ${cap} episode(s), so the library holds more than ${cap} and the remainder was never read`,
      };
    }
    return { items, scanned: items.length, complete: true, failure: null, reason: null };
  } catch (err) {
    // The walk rejects, it does not truncate, so there is nothing trustworthy
    // left to report. Describe this tool's own state, not the walk's: getAllPages
    // fetches page by page and only discards what it accumulated when a page
    // throws, so "nothing was read" would be a claim about the world rather
    // than an observation, and pages may well have been served.
    return {
      items: [],
      scanned: 0,
      complete: false,
      failure: 'walk_failed',
      reason: `the library walk did not finish, so no episode rows were retained: ${describeScanError(err)}`,
    };
  }
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };
function textResult(text: string, s?: Record<string, unknown>): ToolResult { return { content: [{ type: 'text', text }], ...(s ? { structuredContent: s } : {}) }; }
function emit(fmt: string | undefined, echo: Record<string, unknown>, text: string): ToolResult {
  if (fmt === 'json') return { content: [{ type: 'text', text: JSON.stringify(echo, null, 2) }], structuredContent: echo };
  return { content: [{ type: 'text', text }], structuredContent: echo };
}

/**
 * Success path for the archive: the delete is not invertible on its own, so the
 * receipt (resolvable via verify_receipt, revertible via undo_mutation) rides
 * both the prose and structuredContent.
 */
function emitWithReceipt(
  fmt: string | undefined,
  echo: Record<string, unknown>,
  text: string,
  receipt: Receipt,
): ToolResult {
  const base = emit(fmt, echo, text);
  return {
    content: [{ type: 'text', text: fmt === 'json' ? base.content[0].text : `${base.content[0].text}\n${formatReceipt(receipt, { expectPresent: false })}` }],
    structuredContent: { ...(base.structuredContent ?? {}), receipt: receipt as unknown as Record<string, unknown> },
  };
}

export function registerEpisodeMgmtTools(server: McpServer, client: SpotifyClient): void {
  server.tool('archive_played_episodes',
    'Remove fully-played episodes from your episode library in bulk (checks resume_point.fully_played). Batch DELETE /me/episodes; archives over 50 episodes require elicitation confirmation (or SPOTIFY_MCP_CONFIRM=never for automation); dry_run supported. Returns a removal receipt (resolvable via verify_receipt, revertible via undo_mutation).',
    {
      dry_run: DryRun,
      response_format: ResponseFormat,
      limit: z.number().int().min(1).max(500).optional().describe('Max episodes to scan (default 100).'),
      // Accepted so a 1.31.0 caller does not get a hard unknown_param error, but
      // deliberately NOT an authorization: this boolean used to bypass the
      // confirmation gate, which is exactly the write-without-a-human the gate
      // exists to prevent. It now only records intent; the elicitation (or the
      // server-wide SPOTIFY_MCP_CONFIRM=never) still decides.
      confirm: z.boolean().optional().describe('Deprecated and ignored: it no longer authorises the write. Over 50 episodes requires elicitation confirmation, or SPOTIFY_MCP_CONFIRM=never.'),
    },
    async (args) => {
      const cap = (args.limit as number) ?? 100;
      const scan = await scanSavedEpisodes(client, cap);
      const items = scan.items;
      const deprecatedInputs = args.confirm === undefined ? [] : ['confirm'];
      const deprecation = deprecatedInputs.length
        ? { deprecated_inputs: deprecatedInputs, deprecation_note: '`confirm` is accepted but ignored: it no longer authorises the delete. Use elicitation, or set SPOTIFY_MCP_CONFIRM=never to automate.' }
        : {};
      const played = items.filter((r) => r?.episode?.resume_point?.fully_played);

      // A partial scan never speaks in totals. The count is qualified as "read",
      // and the destructive path is refused outright: a human confirmation over
      // a list the tool cannot vouch for is still an unauthorised delete of an
      // unknown remainder, so this gate runs before the elicitation does. It
      // also runs before issueReceipt — there is nothing to receipt when the
      // scan never finished, and a receipt would imply a verified removal.
      if (!scan.complete) {
        const partial = {
          ok: false,
          reason: 'scan_incomplete',
          scan_complete: false,
          scan_failure: scan.failure,
          partial_scan: true,
          partial_scan_reason: scan.reason,
          scanned: scan.scanned,
          // Deliberately not `would_remove`: on a scan this tool does not trust
          // that number reads as "there is nothing to remove", which is the
          // exact false clean bill this issue is about.
          played_among_scanned: played.length,
          ...deprecation,
        };
        if (args.dry_run) {
          const preview = played.slice(0, 5).map((r) => r.episode.name);
          return textResult(
            `PARTIAL SCAN — ${scan.reason}.\n${describeDryRun('archive_played_episodes', `${scan.scanned} saved episode(s) read (partial scan)`, played.length === 0
              ? ['would remove nothing among the episode(s) read — the unread remainder may still contain fully-played episodes']
              : [`would remove ${played.length} fully-played episode(s) among the ${scan.scanned} read`, ...preview])}${deprecatedInputs.length ? '\n`confirm` was accepted but ignored: it no longer authorises the delete.' : ''}`,
            { ...partial, ok: true, dry_run: true, ...deprecation },
          );
        }
        return textResult(
          `Refused to remove episodes — the library scan did not finish: ${scan.reason}. ${scan.scanned === 0
            ? 'No episode row was retained, so this scan carries no evidence about what is saved.'
            // The played count is scoped to the rows this scan retained. The
            // clause after it is a statement about this tool, not about the
            // library: where the truncation was actually measured it is in
            // `scan.reason` above, and where it was not, only "cannot show" is
            // true. "The rest of the library was never read" is not available
            // here — that is exactly the unobserved claim #746 exists to kill.
            : `${played.length} fully-played episode(s) were found among the ${scan.scanned} read. This scan cannot show that the whole library was covered, so that is not a complete list.`} Nothing was removed. Retry with a higher \`limit\` (up to 500) if the scan stopped at the limit, or once the library can be read in full.${deprecatedInputs.length ? ' `confirm` was accepted but ignored: it no longer authorises the delete.' : ''}`,
          partial,
        );
      }

      if (played.length === 0) return textResult(`No fully-played episodes in library (scanned ${scan.scanned}).`, { ok: true, scan_complete: true, scanned: scan.scanned, played: 0, ...deprecation });
      const ids = played.map((r) => r.episode.id);
      const uris = played.map((r) => r.episode.uri);
      if (args.dry_run) {
        const preview = played.slice(0, 5).map((r) => r.episode.name);
        // Every exit carries the note, this one included: a dry run is the first
        // call a legacy caller makes, and a preview that says nothing is how an
        // ignored `confirm` stays invisible.
        return textResult(
          `${describeDryRun('archive_played_episodes', `${scan.scanned} saved episodes`, [`would remove ${played.length} fully-played episodes`, ...preview])}${deprecatedInputs.length ? '\n`confirm` was accepted but ignored: it no longer authorises the delete.' : ''}`,
          {
            ok: true,
            dry_run: true,
            scan_complete: true,
            scanned: scan.scanned,
            would_remove: played.length,
            ...deprecation,
          },
        );
      }
      if (played.length > ARCHIVE_ELICIT_THRESHOLD) {
        const verdict = await confirmViaElicitation(server, {
          message: describeConfirmation('remove from episode library', 'fully-played episodes', [
            `Remove ${played.length} fully-played episode(s):`,
            ...uris.slice(0, 5),
            ...(uris.length > 5 ? [`(…and ${uris.length - 5} more)`] : []),
          ]),
          confirmLabel: 'Archive played episodes',
        });
        const refusal = requiredConfirmationRefusal(verdict);
        // Tell a legacy caller on every exit, not just the happy path: this is
        // where a caller that sent `confirm: true` learns it did not authorise
        // anything.
        if (refusal) return textResult(refusal.message, { ...refusal.payload, ...deprecation });
      }
      let removed = 0;
      const episodeCap = capFor('episodes');
      for (let i = 0; i < ids.length; i += episodeCap) {
        const batch = ids.slice(i, i + episodeCap);
        await client.delete(`/me/episodes?ids=${batch.join(',')}`);
        removed += batch.length;
      }
      // A library removal is not invertible on its own: once the DELETEs land the
      // episodes are gone, so the receipt (resolvable via verify_receipt and
      // undo_mutation) is the only record that they were ever there.
      const receipt = await issueReceipt(client, { kind: 'library', uris, expectPresent: false });
      return emitWithReceipt(args.response_format as string, { ok: true, scan_complete: true, scanned: scan.scanned, removed, ids, ...deprecation }, `Archived ${removed} fully-played episodes.`, receipt);
    });
}
