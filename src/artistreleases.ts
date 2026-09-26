/**
 * One canonical artist-release probe (#900).
 *
 * Five tools want the same thing — "what is the newest thing this artist put
 * out?" — and each used to spell its own request: `limit` 5 in
 * `swarm3_discovery`, `limit` 10 with no `include_groups` in `freshness`, and
 * four different `include_groups`/`limit` combinations across the discovery
 * radars. The read cache in `client.ts` keys on the whole request target
 * (#678), so none of those spellings could ever share an entry: one session
 * running `whats_new` and `artistwatch_new_additions` over the same 30
 * followed artists spent 60 requests to answer 30 artists' worth of
 * questions, and a third and fourth radar over the same artists spent 60
 * more for the same 30 answers.
 *
 * The fix is a single request shape that every caller routes through, so the
 * first probe for an artist fills the cache and the rest are served from it.
 * Callers that want fewer rows than the canonical page get a slice in memory
 * — never a smaller `limit` on the wire, which would be a second cache key.
 *
 * Endpoint: `GET /artists/{id}/albums`, verified against the official OpenAPI
 * schema (`developer.spotify.com/reference/web-api/open-api-schema.yaml`):
 * live and not deprecated, with `include_groups`, `market`, `offset` and a
 * `limit` whose documented maximum is 10 — which is why the canonical page is
 * the schema maximum and not the 50 a caller might ask for. That maximum is
 * not restated as a literal here; it is the shared `ARTIST_ALBUM_PAGE_LIMIT`
 * (see the constant below). Note that the neighbouring
 * `GET /artists/{id}/top-tracks` is a different endpoint which Spotify
 * *removed* in Feb 2026 (AGENTS.md §2) — nothing here reads it.
 *
 * Two properties this module is responsible for:
 *
 * 1. **One key per artist.** The artist id is in the path, so probing artist B
 *    can never be answered from artist A's entry. The read cache is keyed on
 *    the full request target, so identity is structural, not a convention a
 *    future call site has to remember.
 * 2. **`fromCache` is observed, never assumed.** It is read out of the
 *    client's cache before the request, so it says "a request was issued"
 *    when one was. A probe that quietly reported a hit it did not get — or a
 *    miss it did — is the AGENTS.md §6 failure: a correctly named field that
 *    lies about its value.
 */
import { cacheKey } from './cache.js';
import type { SpotifyClient } from './client.js';
import { ARTIST_ALBUM_PAGE_LIMIT } from './tools/catalog.js';
import type { SpotifyArtistAlbumRow } from './types/spotify.js';

/**
 * Rows per canonical probe. This is the schema's documented maximum for
 * `GET /artists/{id}/albums?limit=` (Feb-2026), not a tuning choice — asking
 * for more is a 400.
 *
 * The value is the shared `ARTIST_ALBUM_PAGE_LIMIT` from `tools/catalog.ts`
 * rather than a second literal. #1209 was four call sites each carrying their
 * own number at this endpoint while the correct one sat unused in the repo;
 * re-declaring it here would have been the same defect a fifth time, in the
 * one module whose entire purpose is to be the single place this request is
 * written down. `tests/artist-albums-limit-guard.test.ts` pins the derivation.
 */
export const ARTIST_RELEASE_PROBE_LIMIT = ARTIST_ALBUM_PAGE_LIMIT;

/**
 * Groups the canonical probe asks for: the artist's own albums and singles.
 * `appears_on` and `compilation` are deliberately excluded — a followed
 * artist's appearance on someone else's record is not that artist's new
 * release, and letting those groups fill the page pushed genuinely new
 * releases off the end of it.
 */
export const ARTIST_RELEASE_PROBE_GROUPS = 'album,single';

/** API path for one artist's release page. */
export function artistReleaseProbePath(artistId: string): string {
  return `/artists/${encodeURIComponent(artistId)}/albums`;
}

/**
 * The one param object, built fresh per call so a caller cannot mutate a
 * shared literal, and from the two constants above so there is a single place
 * the canonical request is written down.
 */
export function artistReleaseProbeParams(): Record<string, string> {
  return {
    include_groups: ARTIST_RELEASE_PROBE_GROUPS,
    limit: String(ARTIST_RELEASE_PROBE_LIMIT),
  };
}

/**
 * The canonical request target exactly as `SpotifyClient.buildUrl` composes
 * it. Exported so a test can assert that every call site emits these bytes
 * rather than trusting that they do.
 */
export function artistReleaseProbeUrl(artistId: string): string {
  return `${artistReleaseProbePath(artistId)}?${new URLSearchParams(artistReleaseProbeParams())}`;
}

export interface ArtistReleaseProbe {
  /** The canonical page, minus null rows. Never re-aliased across callers. */
  items: SpotifyArtistAlbumRow[];
  /**
   * True only when the read cache answered this probe and no request reached
   * the API. False for a client with the cache disabled, which does issue the
   * request — so the count of `fromCache` false values is the request count.
   */
  fromCache: boolean;
}

/** Rows out of an unknown probe body, dropping the nulls the API can send. */
function rowsOf(body: unknown): SpotifyArtistAlbumRow[] {
  const items = (body as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((row): row is SpotifyArtistAlbumRow => row != null);
}

/**
 * Read one artist's canonical release page.
 *
 * A `rows` option trims the result in memory for callers that only need a
 * handful; it never reaches the wire, because a different `limit` is a
 * different cache key and would defeat the sharing this exists to create.
 * Callers that want the newest release should pass no `rows` and read the
 * whole page — trimming to "the first N" would silently assume an ordering
 * the schema does not promise.
 */
export async function probeArtistReleases(
  client: SpotifyClient,
  artistId: string,
  options: { rows?: number } = {},
): Promise<ArtistReleaseProbe> {
  const path = artistReleaseProbePath(artistId);
  const params = artistReleaseProbeParams();
  // Same key SpotifyClient.get derives internally: buildUrl's output with the
  // base URL stripped, run through cacheKey's order-insensitive normaliser.
  const key = cacheKey('GET', path, params);
  const cache = client.cache;
  if (cache) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      return { items: trim(rowsOf(hit), options.rows), fromCache: true };
    }
  }
  const body = await client.get<{ items?: unknown }>(path, params);
  return { items: trim(rowsOf(body), options.rows), fromCache: false };
}

function trim(rows: SpotifyArtistAlbumRow[], rowsWanted?: number): SpotifyArtistAlbumRow[] {
  if (rowsWanted === undefined || rowsWanted >= rows.length) return rows;
  return rows.slice(0, Math.max(0, rowsWanted));
}
