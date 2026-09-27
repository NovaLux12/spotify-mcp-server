/**
 * Spotify's February 2026 RESPONSE-FIELD removals (#639) — the one place this
 * repository records which fields the Web API stopped returning.
 *
 * Scope, and the line it does not cross: this is about FIELDS on objects a live
 * endpoint still returns. The batch of endpoints Spotify removed in the same
 * changelog is a separate concern with its own home — `GATED_FAMILIES` in
 * `src/gating.ts`, and #638, which deleted the tools. Do not add a row here for
 * an endpoint. AGENTS.md §2 carries both tables.
 *
 * The list below is transcribed from two citable sources, read on 2026-09-27,
 * and not from memory or from a local probe:
 *
 *   - Spotify's February 2026 changelog
 *     (https://developer.spotify.com/documentation/web-api/references/changes/february-2026),
 *     whose "Changes to fields" section marks each entry `[REMOVED]` and, for
 *     most, quotes the field's own description.
 *   - The live OpenAPI schema
 *     (https://developer.spotify.com/reference/web-api/open-api-schema.yaml).
 *
 * The two sources DISAGREE, and the disagreement is the reason both are cited.
 * The schema is only partially updated: it has already dropped `popularity`
 * from `SimplifiedTrackObject` and `label`/`popularity`/`album_group` from
 * `AlbumObject`, yet it still carries `available_markets` on `TrackObject`,
 * `followers` on `ArtistObject` and `PublicUserObject`, and the whole user
 * profile's removed fields on `PrivateUserObject`. So the schema corroborates
 * some rows and contradicts others, and a row is recorded here when the
 * CHANGELOG says `[REMOVED]` — the dated, explicit statement of intent — not
 * when the schema still has a stale copy. A schema that still declares a field
 * is not evidence the field survives.
 *
 * Two fields in the February changelog are NOT here, deliberately:
 * `external_ids` on Album and Track. Both were marked `[REMOVED]` in February
 * and then marked `[REVERTED]` in the March 2026 changelog
 * (https://developer.spotify.com/documentation/web-api/references/changes/march-2026),
 * which restores them. Code reading `external_ids` is correct and is left
 * alone; the March revert post-dates the February removal, which is exactly the
 * kind of thing a "Spotify removed field X" note gets wrong by omission.
 *
 * `available_markets` is removed on Album, Audiobook, Chapter, Show and Track.
 * No code in this tree reads it, and `src/tools/playbackintel.ts` already
 * discloses the substitution (`is_playable` per market is the API's own
 * answer). It is listed here so the removal is recorded even though the fix
 * was already made, and so the guard test below has something to assert.
 *
 * What "removed" costs a caller, and the rule this table exists to enforce:
 * a field that is gone is `undefined` on every registration created after
 * November 2024, and the failure this repository has actually shipped is
 * coercing that `undefined` into something that reads like a measurement —
 * a throttled stream lookup recorded as `0 streams` (#803), a `name: string`
 * arriving as `undefined` (#804). So the rule for every consumer of a field
 * named here is the same: absence must stay `undefined` and be omitted, or be
 * reported as unavailable WITH the reason. It must never become `0`, `''`,
 * `'unknown'`, a bucket name, or a byline that reads like a real value.
 */
export const FEB_2026_CHANGELOG = 'https://developer.spotify.com/documentation/web-api/references/changes/february-2026';

/** One content type's worth of removals, keyed as the payload spells the field. */
export interface RemovedField {
  /** The field name exactly as the payload spells it. */
  field: string;
  /** Content types this removal applies to. */
  types: readonly string[];
  /** The changelog's own description of the field, where it gives one. */
  changelog: string;
}

/**
 * Every response field Spotify marked `[REMOVED]` in February 2026 and has not
 * since restored. Ordered as the changelog orders them: by content type, then
 * by field, so a reader can diff this table against the changelog's own
 * "Changes to fields" section line for line.
 */
export const FEB_2026_REMOVED_FIELDS: readonly RemovedField[] = Object.freeze([
  { field: 'album_group', types: ['album'], changelog: 'Describes the relationship between the artist and the album' },
  { field: 'available_markets', types: ['album'], changelog: 'The markets in which the album is available: ISO 3166-1 alpha-2 country codes' },
  { field: 'label', types: ['album'], changelog: 'The label associated with the album' },
  { field: 'popularity', types: ['album'], changelog: 'The popularity of the album. The value will be between 0 and 100, with 100 being the most popular' },
  { field: 'followers', types: ['artist'], changelog: 'Information about the followers of the artist' },
  { field: 'popularity', types: ['artist'], changelog: "The popularity of the artist. The value will be between 0 and 100, with 100 being the most popular. The artist's popularity is calculated from the popularity of all the artist's tracks" },
  { field: 'available_markets', types: ['audiobook'], changelog: 'A list of the countries in which the audiobook can be played, identified by their ISO 3166-1 alpha-2 code' },
  { field: 'publisher', types: ['audiobook'], changelog: 'The publisher of the audiobook' },
  { field: 'available_markets', types: ['chapter'], changelog: 'A list of the countries in which the audiobook can be played, identified by their ISO 3166-1 alpha-2 code' },
  { field: 'available_markets', types: ['show'], changelog: 'A list of the countries in which the show can be played, identified by their ISO 3166-1 alpha-2 code' },
  { field: 'publisher', types: ['show'], changelog: 'The publisher of the show' },
  { field: 'available_markets', types: ['track'], changelog: 'A list of the countries in which the track can be played, identified by their ISO 3166-1 alpha-2 code' },
  { field: 'linked_from', types: ['track'], changelog: 'Original track when relinked' },
  { field: 'popularity', types: ['track'], changelog: 'The popularity of the track. The value will be between 0 and 100, with 100 being the most popular' },
  { field: 'country', types: ['user'], changelog: "The country of the user, as set in the user's account profile. An ISO 3166-1 alpha-2 country code" },
  { field: 'email', types: ['user'], changelog: "The user's email address, as entered by the user when creating their account" },
  { field: 'explicit_content', types: ['user'], changelog: "The user's explicit content settings" },
  { field: 'followers', types: ['user'], changelog: 'Information about the followers of the user' },
  { field: 'product', types: ['user'], changelog: "The user's Spotify subscription level: \"premium\", \"free\", etc. (The subscription level \"open\" can be considered the same as \"free\".)" },
] as RemovedField[]);

/** Every distinct field name in {@link FEB_2026_REMOVED_FIELDS}, sorted. */
export const FEB_2026_REMOVED_FIELD_NAMES: readonly string[] = Object.freeze(
  [...new Set(FEB_2026_REMOVED_FIELDS.map((r) => r.field))].sort(),
);

/**
 * The removals a payload fixture can exercise: a representative object per
 * content type with every one of its removed fields deleted. A field that is
 * absent here cannot be tested for the failure it was removed to prevent, and
 * the guard test asserts this map against {@link FEB_2026_REMOVED_FIELDS} so a
 * newly recorded removal cannot ship without one.
 *
 * `base` is the shape as the API returns it WITH the removals applied; the
 * accessor layer is asked what a caller sees for each one. The values in `base`
 * are deliberately never read: the assertion is that a removed field is not
 * something a payload can still supply, so only its absence is meaningful.
 */
export const FEB_2026_REMOVED_FIXTURES: Readonly<Record<string, { type: string; base: Record<string, unknown> }>> = Object.freeze({
  album: { type: 'album', base: { id: 'album-id', name: 'Album', album_type: 'album', release_date: '2026-01-01', total_tracks: 12 } },
  artist: { type: 'artist', base: { id: 'artist-id', name: 'Artist', genres: ['pop'] } },
  audiobook: { type: 'audiobook', base: { id: 'book-id', name: 'Book', total_chapters: 8 } },
  chapter: { type: 'chapter', base: { id: 'chapter-id', name: 'Chapter' } },
  show: { type: 'show', base: { id: 'show-id', name: 'Show', total_episodes: 20 } },
  track: { type: 'track', base: { id: 'track-id', name: 'Track', duration_ms: 210000 } },
  user: { type: 'user', base: { id: 'user-id', display_name: 'Listener', uri: 'spotify:user:user-id' } },
});

/**
 * The removed fields a given content type no longer returns.
 *
 * This is a declaration query, not a runtime read: it says which fields the
 * API stopped sending, and never inspects a payload. A caller that needs to
 * render "not available" with a reason asks this, so the reason is generated
 * from the same table the rest of the module is written against.
 */
export function removedFieldsFor(type: string): readonly string[] {
  return Object.freeze(FEB_2026_REMOVED_FIELDS.filter((r) => r.types.includes(type)).map((r) => r.field));
}

/** True when `type` is a content type this table has a removal row for. */
export function hasRemovedFields(type: string): boolean {
  return FEB_2026_REMOVED_FIELDS.some((r) => r.types.includes(type));
}

/**
 * The ` by <publisher>` fragment for a show or audiobook line, or `''` when
 * the payload carried no publisher.
 *
 * `publisher` was removed from Show and Audiobook payloads in February 2026
 * (`FEB_2026_REMOVED_FIELDS`), so on any registration newer than Nov-2024 it
 * is absent. The failure this replaces is
 * `` `${x.publisher ?? 'unknown publisher'}` ``, which manufactures a byline
 * that is textually indistinguishable from a show actually published by
 * someone called "unknown publisher" — and, in the tools that GROUP by
 * publisher, a census of one fabricated bucket presented as a finding.
 *
 * Returning `''` rather than a placeholder is the honest shape: the sentence
 * still reads, and nothing on the line claims a fact nobody read. A
 * grandfathered pre-Nov-2024 registration that still sends `publisher` keeps
 * its byline, because a real value is not the problem this fixes.
 */
export function publisherByline(publisher: string | null | undefined): string {
  const name = presentFacet(publisher);
  return name ? ` by ${name}` : '';
}

/**
 * A show's or audiobook's publisher, or `''` when the payload carried none.
 *
 * The same problem as {@link publisherByline}, in the places where `by` is
 * already spoken for: an audiobook line reads `"The Hobbit" by J. R. R.
 * Tolkien`, so a publisher cannot also be introduced with `by` without reading
 * as a second author. This returns the bare name with no punctuation attached
 * and leaves the grammar to the call site, because the two grammars genuinely
 * differ — one site writes `Publisher (Edition) | 32 chapters` and the other
 * writes `(Publisher, 32 chapters)`.
 *
 * As with the byline, a real publisher is kept. `audiobooks.ts` used to render
 * `HarperCollins` on every audiobook whose registration predates the removal,
 * and that line was true; only the `'Unknown publisher'` fallback was the
 * fabrication.
 */
export function publisherAttribution(publisher: string | null | undefined): string {
  return presentFacet(publisher) ?? '';
}

/**
 * A removed field's value, or `null` when the payload did not really carry
 * one. The single place the "is this a value or a stand-in?" question is
 * asked, so every accessor above agrees on what counts as present.
 *
 * The test is deliberately narrow: a string, trimmed, non-empty. A number
 * would be a different bug — a `popularity` that arrived as `0` is a real
 * measurement of zero and must survive — so non-strings are treated as absent
 * here and the numeric facets are compared on their own terms by their own
 * callers rather than funnelled through this.
 */
function presentFacet(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The outcome of grouping rows by a field the API may no longer return. */
export interface FacetGroups<T> {
  /** Buckets, keyed by a value the payload actually carried. */
  groups: Map<string, T[]>;
  /** Rows that carried a non-empty value for the field. */
  reported: number;
  /** Rows that did not — and are therefore in no bucket at all. */
  missing: number;
}

/**
 * Group rows by a field Spotify may no longer return, WITHOUT inventing a
 * bucket for the rows that lack it.
 *
 * This exists because of an asymmetry that runs through every other read of a
 * removed field in this repository. A guarded single-value read is already
 * honest: the `?? 0` sites were fixed, and the ones that print a placeholder
 * are self-describing. What is not honest is AGGREGATING the field — using it
 * as a bucket key, a group label, a match predicate or a count — because a
 * placeholder then stops being a token and becomes a finding.
 *
 * The shape of the failure, in every instance found in this tree:
 *
 *     const lbl = album.label ?? '(unknown label)';   // #639, swarm3_discovery
 *
 * `label` is gone, so *every* successfully-read album takes the fallback. The
 * census does not report a missing facet; it reports one label called
 * `(unknown label)` containing all N albums, and publishes `distinct_labels: 1`
 * as though the user's library were uniformly unlabelled. The comment above
 * that line (#1224) carefully excludes albums whose read FAILED so a failed
 * lookup is not filed as a real label — and the field removal guarantees that
 * every SUCCESSFUL read is filed there anyway. This is the #803 class one
 * aggregation layer over: a value that could not be read, reported as a
 * measurement.
 *
 * So a row with no value goes in no bucket, and the caller is handed
 * `reported`/`missing` to publish as coverage. `following_analytics` already
 * does this for `popularity` and `followers` — returning an empty item list
 * with `available: false` and a reason — and that is the shape this makes
 * available to the census and portfolio tools that were missing it.
 */
export function facetGroups<T>(
  rows: readonly T[],
  read: (row: T) => string | null | undefined,
): FacetGroups<T> {
  const groups = new Map<string, T[]>();
  let reported = 0;
  for (const row of rows) {
    const raw = read(row);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    reported += 1;
    const bucket = groups.get(value);
    if (bucket) bucket.push(row);
    else groups.set(value, [row]);
  }
  return { groups, reported, missing: rows.length - reported };
}

/**
 * The one-line reason a facet could not be derived, phrased for a caller that
 * would otherwise be looking at a silently narrowed answer.
 *
 * `field` and `type` name the changelog row (`label` on an album) so the reader
 * can look the removal up rather than take the server's word for it.
 */
export function facetUnavailableReason(field: string, type: string): string {
  return `Spotify removed \`${field}\` from ${type} payloads in February 2026, so this rollup has no ${field} to group by.`;
}

/**
 * The coverage suffix for a prose line: how many rows the facet actually
 * reached. Published whether or not the facet is complete, because a partial
 * census that reports only its buckets is a census whose total does not add up
 * and gives the reader no way to notice.
 */
export function facetCoverageNote(reported: number, total: number, noun: string): string {
  const plural = `${noun}${total === 1 ? '' : 's'}`;
  return total === 0
    ? `no ${plural} to group`
    : `grouped ${reported}/${total} ${plural} that still report the field; ${total - reported} did not`;
}

