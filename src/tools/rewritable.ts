/**
 * The unavailable-row guard for full-sequence playlist rewrites (#860), and
 * the truncated-read guard for the same commit path (#1310).
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
 * #1310 is the same loss by a different mechanism. The URI list a rewrite
 * sends is built from an item walk capped at `SPOTIFY_MCP_FETCH_ALL_CAP`, so
 * on a playlist larger than the cap the rows past it are simply ABSENT from
 * the PUT — and an absent row is a deleted row. `truncatedRowNotice` refuses
 * that, and names the position the unread region starts at rather than
 * reporting a count computed from the rows that happened to be read.
 *
 * The two guards are SEPARATE predicates that COMPOSE, not one predicate that
 * grew a clause. `unavailableRowNotice` stays `null` for an all-playable
 * playlist even when the walk was truncated: `playlist_union` and
 * `playlist_subtract` walk sources to the cap on purpose, disclose it in the
 * payload and in the prompt, and are gated by a mandatory elicitation on every
 * destructive impact — so for them a truncated read is disclosed, not refused.
 * The single-playlist rewrites are the fourth case, and the reason is not
 * only that a prompt is missing. For `playlist_sort`, `playlist_shuffle` and
 * `playlist_reverse` there is no prompt at all. `playlist_trim` has one since
 * #872, and still refuses here for `keep_which: "last"` and `"random"`: a
 * truncated read makes those keep the wrong rows, and a prompt that says "the
 * true impact may be larger" is a claim about how much is deleted, not about
 * which rows survive. Its `first` is left to that gate, because a prefix of
 * the read IS the playlist's prefix and the unread tail is what the trim
 * deletes anyway. The common thread is that the rewrite is computed from the
 * rows that were read: on a truncated read the answer is not a smaller version
 * of the right one, it is a different one.
 *
 * The predicates are pure and live here because the guard is not one module's
 * policy. `playlists.ts` and `playlisthealth.ts` carry the #1310 truncation
 * refusal. `swarm4_playlists.ts` also commits through one full atomic replace
 * and also calls `assertPlaylistRewritable`, but its `fetchAllItems` walks with
 * a bare `getAllPages` and keeps no verdict, so its eleven committing tools
 * are NOT covered by the truncation guard yet — `assertRewritable` there
 * passes no `truncated` flag and the guard cannot infer one. Closing that is
 * its own change, not something to half-apply here; until it lands, a
 * `swarm4_*` rewrite over a playlist larger than the cap still deletes the
 * unread tail.
 */
import type { PlaylistItemObject } from '../types/spotify.js';

/** Positions are quoted 1-based, matching how the API pages a playlist. */
const MAX_QUOTED_POSITIONS = 10;

const DEFAULT_REMEDY = 'Remove the unavailable items first, then retry.';

const DEFAULT_TRUNCATION_REMEDY =
  'Raise SPOTIFY_MCP_FETCH_ALL_CAP above this playlist\'s row count and retry.';

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
 * The refusal text for a rewrite whose item walk stopped short of the playlist
 * (#1310), or null when the walk reached the end.
 *
 * The refusal names the unread REGION, not a count of what survived. "Reversed
 * 500 item(s)" is the false claim #1310 is filed on — a number the caller reads
 * as "this is the whole playlist" when it is the cap. `total`, when the caller
 * could read Spotify's own `items.total`, turns "at least these many are
 * missing" into a number nobody has to guess at.
 */
export function truncatedRowNotice(
  label: string,
  read: { truncated: boolean; rowCount: number; cap: number; total?: number },
  options: { remedy?: string } = {},
): string | null {
  if (!read.truncated) return null;
  const { rowCount, cap, total } = read;
  const unread = typeof total === 'number' && total > rowCount
    ? ` (items.total = ${total}, so at least ${total - rowCount} more row(s) were never read)`
    : ' (the playlist\'s own item count was not readable, so the size of the unread region is unknown)';
  return `"${label}" could only be read to the configured fetch-all cap of ${cap} row(s) — ${rowCount} row(s) were read${unread}. `
    + `This rewrite commits one atomic full-content replace, so every row past position ${rowCount} would be DELETED from the playlist rather than reordered. `
    + `Nothing was changed. ${options.remedy ?? DEFAULT_TRUNCATION_REMEDY}`;
}

/**
 * Guard for every tool whose commit path is a full atomic replace: throw
 * before the first PUT, not after. Call it on the playlist whose live rows
 * the rewrite would replace — for a set operation that is the target, not the
 * sources being read.
 *
 * `total` is Spotify's own `items.total` when the caller read it, and stays
 * undefined when it could not — an unread count is never substituted with the
 * count that could be read.
 */
export function assertPlaylistRewritable(
  label: string,
  positions: readonly number[],
  options: { truncated?: boolean; remedy?: string } = {},
): void {
  const notice = unavailableRowNotice(label, positions, options);
  if (notice !== null) throw new Error(notice);
}

/**
 * #1310 — the truncation half of the guard, for a commit path that has NO
 * elicitation gate to disclose through.
 *
 * A separate entry point from {@link assertPlaylistRewritable} on purpose: the
 * two compose (`assertPlaylistRewriteReadable(...); assertPlaylistRewritable(...)`)
 * and neither replaces nor relaxes the other, so the #860 unavailable-row
 * refusal and the #1310 truncated-read refusal both still fire, and the
 * confirmation gate this module never owned is untouched.
 */
export function assertPlaylistRewriteReadable(
  label: string,
  read: { truncated: boolean; rowCount: number; cap: number; total?: number },
  options: { remedy?: string } = {},
): void {
  const notice = truncatedRowNotice(label, read, options);
  if (notice !== null) throw new Error(notice);
}
