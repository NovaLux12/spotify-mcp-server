/**
 * The unavailable-row guard for full-sequence playlist rewrites (#860).
 *
 * Every ordered rewrite in this server commits through one atomic
 * `PUT /playlists/{id}/items` that replaces the whole playlist with a URI
 * list. Spotify returns a removed, relabelled or region-unavailable row with
 * `item: null`, so that row carries no URI: a URI-based replace cannot put it
 * back, and the first PUT deletes it from the live playlist for good. The
 * counts the tool reports afterwards are computed from the already-filtered
 * list, so nothing in the response reveals the loss, and a later
 * `diff_since_snapshot` will not attribute it to this call.
 *
 * The answer is a REFUSAL, not a confirmation. An elicitation prompt can only
 * describe a loss in words; the row is still gone afterwards, and an agent
 * that clicks through a bulk prompt does not read ten positions. So the
 * rewrite is refused up front, naming how many rows are affected and at which
 * 1-based positions, with `remove_unavailable_playlist_items` as the way out.
 * `dry_run` still renders its plan — the guard sits after the plan branch, so
 * a preview is never blocked and the caller can see what it would have done.
 *
 * The predicate is pure and lives here because the guard is not one module's
 * policy: swarm3_playlistops.ts, swarm4_playlists.ts and playlists.ts all
 * commit the same way and all need the same answer.
 */
import type { PlaylistItemObject } from '../types/spotify.js';

/** Positions are quoted 1-based, matching how the API pages a playlist. */
const MAX_QUOTED_POSITIONS = 10;

const DEFAULT_REMEDY = 'Remove the unavailable items first, then retry.';

/**
 * 1-based positions of the rows Spotify returned with no playable item, in
 * playlist order. An empty array means the rows the caller read are all
 * addressable by URI.
 */
export function unavailableRowPositions(items: readonly PlaylistItemObject[]): number[] {
  return items.map((row, index) => (row.item?.uri ? -1 : index + 1)).filter((position) => position > 0);
}

/**
 * The refusal text for a playlist that cannot be rewritten, or null when every
 * row read is addressable. Exposed separately from the throw so a dry run can
 * disclose the same thing in the same words instead of previewing a commit
 * that will be refused.
 *
 * `truncated` says the item walk stopped at the fetch-all cap, so the quoted
 * positions and the count are a lower bound: rows past the cap went unread.
 */
export function unavailableRowNotice(
  label: string,
  positions: readonly number[],
  options: { truncated?: boolean; remedy?: string } = {},
): string | null {
  if (positions.length === 0) return null;
  const shown = positions.slice(0, MAX_QUOTED_POSITIONS).join(', ');
  return `"${label}" contains ${positions.length} unavailable item(s) at 1-based position(s) ${shown}`
    + `${positions.length > MAX_QUOTED_POSITIONS ? '…' : ''}. A full rewrite would drop them from the playlist. `
    + `${options.remedy ?? DEFAULT_REMEDY}`
    + (options.truncated
      ? ' The item walk stopped at the configured cap, so this count is a lower bound and the positions past the cap are unknown.'
      : '');
}

/**
 * Guard for every tool whose commit path is a full atomic replace: throw
 * before the first PUT, not after. Call it on the playlist whose live rows
 * the rewrite would replace — for a set operation that is the target, not the
 * sources being read.
 */
export function assertPlaylistRewritable(
  label: string,
  positions: readonly number[],
  options: { truncated?: boolean; remedy?: string } = {},
): void {
  const notice = unavailableRowNotice(label, positions, options);
  if (notice !== null) throw new Error(notice);
}
