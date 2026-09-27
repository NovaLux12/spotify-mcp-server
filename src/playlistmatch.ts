/**
 * The one duplicate and artist matching vocabulary shared by every playlist
 * tool (#885).
 *
 * Before this module the five duplicate tools and the four artist tools each
 * spelled their own rule: `playlist_health_check` keyed duplicates on URI,
 * `find_duplicates_in_playlist` counted an exact-URI group and a relinked
 * group separately, `playlist_dedupe_advanced` keyed on bare name,
 * `remove_duplicate_playlist_items` and `clean_all_playlists` flipped an
 * `include_relinked` boolean, and `playlist_artist_heat` credited only
 * `artists[0]` while the exclusion and removal tools matched any credit. The
 * same playlist therefore produced a different duplicate count per tool and a
 * different artist count per tool, with nothing in the payload saying which
 * rule produced it.
 *
 * The rule now lives here once. Every tool that reports or collapses
 * duplicates calls {@link groupDuplicates}; every tool that matches a track
 * against an artist reference calls {@link trackMatchesArtist}. Given the same
 * `match_by` the tools agree, and the payload names the rule that was applied
 * so a count is never unattributable.
 *
 * A matcher that quietly matches nothing is the failure this module exists to
 * remove: `playlist_exclude_artists` compared the caller's reference against
 * `artist.id` only, so a name matched no row and the tool reported "nothing to
 * remove" — indistinguishable from an artist who genuinely has no track in the
 * playlist. {@link trackMatchesArtist} matches on id OR name and says which.
 */
import { z } from 'zod';
import { classifySpotifyReference } from './refs.js';
import type { PlaylistItemObject } from './types/spotify.js';

/**
 * @see withPlaylistInputMetadata in ../shaping.js — the field contract shared
 * with the retired-playlist-spelling deprecation, which is a different
 * mechanism serving the same host-facing fields.
 */

/** The ways a playlist item can be judged "the same item" as another. */
export const DUPLICATE_MATCH_BY = ['uri', 'name_artist', 'name'] as const;

export type DuplicateMatchBy = (typeof DUPLICATE_MATCH_BY)[number];

/**
 * The one default every duplicate tool uses.
 *
 * `uri` is the narrowest rule and the one three of the five tools already
 * applied by default, so making it the shared default changes no default
 * behaviour that a caller was relying on.
 */
export const DEFAULT_DUPLICATE_MATCH_BY: DuplicateMatchBy = 'uri';

/** Human-readable gloss per rule, reused in prose and in the payload. */
export const DUPLICATE_MATCH_RULE: Readonly<Record<DuplicateMatchBy, string>> = Object.freeze({
  uri: 'exact URI — the same track object added twice',
  name_artist: 'case-insensitive name plus the full set of credited artist names — catches a relink or remaster published under a new URI',
  name: 'case-insensitive name only — the widest rule; two different songs sharing a title collapse into one group',
});

/**
 * The shared `match_by` parameter.
 *
 * One declaration, so the vocabulary and the wording cannot drift between the
 * tools that accept it. There is deliberately NO zod `.default()` here: the
 * default is applied by {@link resolveMatchBy} instead, because a schema default
 * makes "the caller said nothing" indistinguishable from "the caller said
 * `uri`", and {@link IncludeRelinkedParam} has to tell those two apart to map a
 * legacy boolean onto the rule it used to mean. The default is still stated in
 * the description, which is where a host reads it.
 */
export const DuplicateMatchByParam = z
  .enum(DUPLICATE_MATCH_BY)
  .optional()
  .describe(
    'Which rule decides that two items are the same: `uri` (exact URI, the default), '
      + '`name_artist` (case-insensitive name + credited artists, catches relinks/remasters), '
      + 'or `name` (case-insensitive name only). The rule applied is echoed in the result as `match_by`.',
  );

/**
 * The retired `include_relinked` boolean, on the two tools that published it.
 *
 * It stays callable for one release per AGENTS.md §5. It could not express the
 * `name` rule — that is why `match_by` replaced it — but it is a supported input
 * for now, not an unknown parameter, and it is declared here so the two tools
 * that had it keep advertising the same thing.
 *
 * The mapping is total and lossless for the two values it ever took: `true` was
 * "URI or relink" and is `name_artist`; `false` was "URI only" and is `uri`.
 */
export const IncludeRelinkedParam = z
  .boolean()
  .optional()
  .describe(
    'Deprecated alias for `match_by`, kept for one release: true is `name_artist` and false is `uri`. '
      + 'It cannot express the `name` rule, which is why `match_by` replaced it. Sending both, where '
      + 'they mean different rules, is an error rather than a silent choice.',
  );

/** The inputs {@link resolveMatchBy} reads, whichever pair a tool declares. */
export interface MatchByInputs {
  readonly match_by?: DuplicateMatchBy;
  readonly include_relinked?: boolean;
}

export interface MatchByResolution {
  /** The one rule to apply, whichever input carried it. */
  readonly matchBy: DuplicateMatchBy;
  /** Retired input names actually present on the call; empty for a canonical call. */
  readonly deprecatedInputs: readonly string[];
  /** One-line migration note, or null for a call with no deprecated input. */
  readonly deprecationNote: string | null;
}

/** The rule each value of the retired boolean used to mean. */
const LEGACY_RELINKED_RULE: Readonly<Record<'true' | 'false', DuplicateMatchBy>> = Object.freeze({
  true: 'name_artist',
  false: 'uri',
});

/**
 * The one place a matching rule is decided.
 *
 * Three inputs can arrive: the canonical `match_by`, the deprecated
 * `include_relinked`, or neither. Neither means the published default, so no
 * tool invents its own. A disagreement is refused by name, because silently
 * picking one of two stated rules is how a caller ends up acting on a
 * deduplication it did not ask for.
 */
export function resolveMatchBy(inputs: MatchByInputs): MatchByResolution {
  const { match_by: matchBy, include_relinked: includeRelinked } = inputs;
  if (includeRelinked === undefined) {
    return {
      matchBy: matchBy ?? DEFAULT_DUPLICATE_MATCH_BY,
      deprecatedInputs: [],
      deprecationNote: null,
    };
  }
  const legacyRule = LEGACY_RELINKED_RULE[String(includeRelinked) as 'true' | 'false'];
  if (matchBy !== undefined && matchBy !== legacyRule) {
    throw new Error(
      `match_by=${matchBy} and include_relinked=${includeRelinked} mean different rules `
        + `(${matchBy} and ${legacyRule}); send match_by only.`,
    );
  }
  return {
    matchBy: matchBy ?? legacyRule,
    deprecatedInputs: ['include_relinked'],
    deprecationNote: `Deprecated input include_relinked=${includeRelinked}; it maps to match_by=${legacyRule}.`,
  };
}

/**
 * Add the deprecation metadata to a payload, but only when a legacy input was
 * actually used — the same `deprecated_inputs` / `deprecation_note` field pair
 * {@link withPlaylistInputMetadata} emits for a retired playlist spelling, so a
 * host reads one convention. It is a separate function because that one
 * resolves playlist *references* and this one resolves a matching *rule*; the
 * field contract is what they share.
 */
export function withMatchByMetadata<T extends Record<string, unknown>>(
  payload: T,
  resolved: MatchByResolution,
): T | (T & { deprecated_inputs: string[]; deprecation_note: string }) {
  if (resolved.deprecatedInputs.length === 0) return payload;
  return {
    ...payload,
    deprecated_inputs: [...resolved.deprecatedInputs],
    deprecation_note: resolved.deprecationNote!,
  };
}

/** Append the same one-line migration note to prose/JSON text. */
export function withMatchByNote(text: string, resolved: MatchByResolution): string {
  return resolved.deprecationNote === null ? text : `${text}\n${resolved.deprecationNote}`;
}

/**
 * The shared `include_featured` parameter.
 *
 * Default `true` because that is what every artist tool already did except
 * `playlist_artist_heat`, which credited only the primary artist; a
 * `false` there reproduces the old primary-artist-only measurement exactly.
 */
export const IncludeFeaturedParam = z
  .boolean()
  .optional()
  .default(true)
  .describe(
    'Count every credited artist, including featured and co-credited ones (default). '
      + 'false credits only the primary (first) artist on each track.',
  );

/** The minimum row shape the shared rules need. */
export interface MatchableItem {
  /** Empty when the item is unavailable; unavailable rows are never grouped. */
  readonly uri: string;
  readonly name: string;
  /** Artist names in credit order. Episodes carry their show name. */
  readonly artistNames: readonly string[];
}

export interface DuplicateOccurrence extends MatchableItem {
  readonly position: number;
}

export interface DuplicateGroup {
  /** The key the rule produced. Namespaced by rule so two rules never collide. */
  readonly key: string;
  /** Occurrences in playlist order; the first is the one keep-first retains. */
  readonly occurrences: readonly DuplicateOccurrence[];
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * The one key function. `name_artist` sorts the artist names so that credit
 * ORDER ("A feat. B" vs "B feat. A") does not split one song into two groups —
 * the same normalisation `trackIdentityKey` applied before this module.
 */
export function duplicateKey(item: MatchableItem, matchBy: DuplicateMatchBy): string {
  const name = normaliseName(item.name);
  switch (matchBy) {
    case 'uri':
      return `uri:${item.uri}`;
    case 'name':
      return `name:${name}`;
    case 'name_artist':
      return `name_artist:${name}|${item.artistNames.map(normaliseName).sort().join(',')}`;
  }
}

/**
 * Adapt paged `/playlists/{id}/items` rows to the shape the rules take.
 *
 * An unavailable row keeps an empty `uri` and an empty name: it occupies a
 * playlist position but must never join a duplicate group, and
 * {@link dedupeItems} keys it alone for the same reason. Episodes carry their
 * show name in place of artist credits, which is what `trackIdentityKey` did.
 */
export function matchableFromPlaylistItems(
  items: readonly PlaylistItemObject[],
): MatchableItem[] {
  return items.map((entry) => {
    const track = entry.item;
    if (!track?.uri) return { uri: '', name: '', artistNames: [] };
    const artistNames =
      'artists' in track && Array.isArray(track.artists)
        ? track.artists.map((credit) => credit.name)
        : ('show' in track && track.show?.name ? [track.show.name] : []);
    return { uri: track.uri, name: track.name, artistNames };
  });
}

/** `"Song" by A, B` — the one human label, so a group reads the same everywhere. */
export function describeMatchableItem(item: MatchableItem): string {
  const artists = item.artistNames.join(', ');
  return `"${item.name}"${artists ? ` by ${artists}` : ''}`;
}

/**
 * Group items under one rule. Rows without a URI (unavailable items) are
 * skipped: they occupy a playlist position but no key, and grouping them
 * under an empty URI would report every unavailable row as a duplicate of
 * every other one.
 *
 * Group and occurrence order both follow playlist order, so two tools given
 * the same rows and the same rule emit the same group count in the same order.
 */
export function groupDuplicates(
  items: readonly MatchableItem[],
  matchBy: DuplicateMatchBy,
): DuplicateGroup[] {
  const byKey = new Map<string, DuplicateOccurrence[]>();
  items.forEach((item, position) => {
    if (!item.uri) return;
    const key = duplicateKey(item, matchBy);
    const occurrence: DuplicateOccurrence = { ...item, position };
    const bucket = byKey.get(key);
    if (bucket) bucket.push(occurrence);
    else byKey.set(key, [occurrence]);
  });
  const groups: DuplicateGroup[] = [];
  for (const [key, occurrences] of byKey) {
    if (occurrences.length > 1) groups.push({ key, occurrences });
  }
  return groups;
}

/**
 * Keep-first (or keep-last) split of rows under one duplicate rule.
 *
 * A row without a URI is never a duplicate of anything, so it always lands in
 * `kept` under a key of its own. `kept` is returned in the caller's original
 * order whichever way `keep` points, because a replacement write sends the
 * whole list and reordering the playlist would be a second, undeclared change.
 */
export function dedupeItems<T extends MatchableItem>(
  items: readonly T[],
  matchBy: DuplicateMatchBy,
  keep: 'first' | 'last',
): { kept: T[]; removed: T[]; groups: number } {
  const byKey = new Map<string, number[]>();
  items.forEach((item, index) => {
    // An unavailable row is keyed alone so it can never merge with anything.
    const key = item.uri ? duplicateKey(item, matchBy) : `unavailable:${index}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(index);
    else byKey.set(key, [index]);
  });

  const dropped = new Set<number>();
  let groups = 0;
  for (const indexes of byKey.values()) {
    if (indexes.length < 2) continue;
    groups++;
    const retainAt = keep === 'first' ? 0 : indexes.length - 1;
    for (const [offset, index] of indexes.entries()) {
      if (offset !== retainAt) dropped.add(index);
    }
  }

  const kept: T[] = [];
  const removed: T[] = [];
  items.forEach((item, index) => (dropped.has(index) ? removed : kept).push(item));
  return { kept, removed, groups };
}

// ---------------------------------------------------------------------------
// Artist matching
// ---------------------------------------------------------------------------

export interface ArtistCredit {
  readonly id?: string;
  readonly name: string;
}

export type ArtistReferenceForm = 'id' | 'uri' | 'url' | 'name';

/** A caller-supplied artist reference, resolved once. */
export interface ArtistReference {
  readonly form: ArtistReferenceForm;
  readonly id: string | null;
  readonly name: string;
}

/**
 * Classify a caller-supplied artist reference. Anything the shared reference
 * policy accepts for an artist — a bare 22-character id, a `spotify:artist:…`
 * URI, or an open.spotify.com artist URL — lands on the bare id; anything else
 * is treated as a name.
 *
 * The `id` form matters as much as the `uri` and `url` forms: an id is the form
 * most callers actually paste, and treating it as a name made every id
 * reference match no credit and report a confident zero.
 */
export function classifyArtistReference(reference: string): ArtistReference {
  const parsed = classifySpotifyReference(reference, 'artist');
  if (
    parsed.valid
    && parsed.kind === 'artist'
    && parsed.id
    && (parsed.form === 'id' || parsed.form === 'uri' || parsed.form === 'url')
  ) {
    return { form: parsed.form, id: parsed.id, name: '' };
  }
  return { form: 'name', id: null, name: reference.trim() };
}

/** How a row came to match, so a zero-match result can say why. */
export interface ArtistMatchVerdict {
  readonly matched: boolean;
  readonly by: 'id' | 'name' | null;
}

const EMPTY_VERDICT: ArtistMatchVerdict = Object.freeze({ matched: false, by: null });

/**
 * The one artist-credit comparison.
 *
 * Matches on id OR case-insensitive name, never on a rule that silently
 * excludes one of them: an id-shaped reference is tried as an id and, if the
 * row has no matching id, as the literal text the caller passed. `includeFeatured`
 * selects all credits or only the primary (first) credit.
 *
 * Returning the reason alongside the boolean is what lets a caller that matched
 * nothing distinguish "this artist has no track here" from "I compared against
 * the wrong field".
 */
export function trackMatchesArtist(
  credits: readonly ArtistCredit[],
  reference: { readonly id: string | null; readonly name: string },
  includeFeatured: boolean,
): ArtistMatchVerdict {
  const considered = includeFeatured ? credits : credits.slice(0, 1);
  if (considered.length === 0) return EMPTY_VERDICT;
  if (reference.id) {
    const wanted = reference.id.toLowerCase();
    if (considered.some((credit) => (credit.id ?? '').toLowerCase() === wanted)) {
      return { matched: true, by: 'id' };
    }
  }
  if (reference.name) {
    const wanted = reference.name.toLowerCase();
    if (considered.some((credit) => credit.name.toLowerCase() === wanted)) {
      return { matched: true, by: 'name' };
    }
  }
  return EMPTY_VERDICT;
}

/**
 * The shared `include_featured` filter over a track's credits. Returns the
 * credits a rule should consider, so every artist tool narrows the same way.
 */
export function artistCreditsFor(
  credits: readonly ArtistCredit[],
  includeFeatured: boolean,
): readonly ArtistCredit[] {
  return includeFeatured ? credits : credits.slice(0, 1);
}

/**
 * The one match against a SET of artist references, for the tools that take
 * more than one (`playlist_exclude_artists`).
 *
 * Returns the reference that matched rather than a bare boolean, so the
 * payload can attribute a removal and a zero-match result can be explained.
 */
export function anyArtistMatches(
  credits: readonly ArtistCredit[],
  references: readonly ArtistReference[],
  includeFeatured: boolean,
): { reference: ArtistReference; by: 'id' | 'name' } | null {
  const considered = artistCreditsFor(credits, includeFeatured);
  for (const reference of references) {
    const verdict = trackMatchesArtist(considered, reference, includeFeatured);
    if (verdict.matched) return { reference, by: verdict.by! };
  }
  return null;
}
