/**
 * The app-registration-gated error contract (#791, #428, #429; audit
 * A14-016/A8-036) -- the graceful 403 mapping for Spotify's
 * app-registration-gated endpoint family (probed 2026-08-26,
 * memory/edge-probe-2026-08-26.json).
 *
 * This module exists so the contract has ONE named installation point that is
 * independent of the toolset system. It used to be installed by
 * `registerExhaust2EnggatingTools`, which meant `SPOTIFY_MCP_DISABLE_TOOLS=
 * exhaust2enggating`, a toolset profile that trims the `catalog` set (for
 * example `SPOTIFY_MCP_TOOLSETS=playback`), or a hand-built host toolset
 * silently removed a cross-cutting error mapping that every other module
 * depends on -- the same platform condition then produced two different
 * explanations depending on the gate, which makes "different errors" reports
 * unreproducible.
 *
 * The contract is installed from the client construction path in
 * `src/index.ts` (`installGatedPathContract`, next to `setProgressReporter`)
 * and is therefore unconditional: no toolset, override, or scope gate can
 * remove it. `src/tools/exhaust2_enggating.ts` keeps the historical import
 * path for the classifier exports (the surface census and its guard test read
 * them from there) but registers no tools and installs nothing.
 *
 * The contract is fail-open by design: apps whose registrations still have
 * access keep working end to end -- only the broken path changes shape.
 *
 * The wrapper annotates and rethrows the original SpotifyApiError (#765);
 * it does NOT replace the error type. Tool-level fallbacks branch on
 * `err instanceof SpotifyApiError && err.status === 403`, and replacing the
 * type with a plain Error destroyed that check, so every tool with its own
 * designed 403 degradation on a gated path hard-failed under the previous
 * wrapper. The annotation (`err.gatedSurface = true`, `err.gatedPath`) lets a
 * sharper diagnosis match the gated class without matching on the message,
 * while `instanceof SpotifyApiError`, `err.status`, and `err.cause` stay
 * meaningful for every caller.
 */
import { SpotifyApiError } from './client.js';
import type { SpotifyClient } from './client.js';

/**
 * One app-registration-gated endpoint family: the runtime classifier, the
 * paths it is documented by, and what the server does about a 403 there.
 *
 * `example` is the representative path the README names for the family. It is
 * asserted against `pattern` by `checkGatedEndpointTruth()` in
 * `scripts/surface-census.mjs`, so a family cannot ship with a doc example its
 * own classifier rejects. `tools` is the hand-maintained list of shipped tools
 * that call the family; the census cross-checks it against a static scan of
 * `client.get` / `client.getAllPages` call sites under `src/tools/`, so a new
 * wrapper has to be named here in the same change that adds it.
 *
 * `fallback` is what a tool does when the family answers 403 on the active
 * registration -- the honest third half of every "this is gated" claim, and
 * the reason the README cannot describe these families as simply "unavailable".
 */
export interface GatedFamily {
  /** Family id, stable; used in README anchors and census errors. */
  id: string;
  /** Human label for the README table. */
  label: string;
  /** The runtime classifier. This is what `isGatedPath` applies. */
  pattern: RegExp;
  /** A path this pattern must accept; asserted by the census. */
  example: string;
  /** Shipped tools that issue a request against this family. */
  tools: readonly string[];
  /**
   * What the server does on 403. `'replaced'` means a documented replacement
   * endpoint is used instead (or per-id reads), so the tool still answers;
   * `'explained'` means the call is still made and the 403 is disclosed.
   */
  fallback: 'replaced' | 'explained';
  /**
   * Why a 403 is expected. `removal` = Spotify's Feb 2026 changelog marks the
   * operation REMOVED; `gated` = observed 403 on a current registration while
   * the operation is not listed as removed. Both are registration-dependent:
   * a grandfathered registration may still answer 200.
   */
  reason: 'removal' | 'gated';
}

/**
 * The #329 app-registration-gated endpoint families (probe 2026-08-26).
 *
 * Three sources describe this class and only two of them are binaries:
 * Spotify's Feb 2026 changelog marks some operations `[REMOVED]`, while the
 * live OpenAPI schema still publishes them carrying `deprecated: true` (e.g.
 * `/artists/{id}/top-tracks`, all seven `Get Several` batch paths). Neither
 * source is the runtime truth: the runtime truth is what a *given* app
 * registration is allowed to read. A registration without the grant answers
 * 403/404/410; a grandfathered one still answers 200. That is why every
 * family here carries a `fallback` -- see the README section generated from
 * this array.
 *
 * A family in this list is a runtime CLASSIFIER, not a claim that a shipped
 * tool calls it. Two families (`browse-new-releases`,
 * `playlist-followers-contains`) have no live call site left -- the tools that
 * used them were migrated onto replacements -- and the pattern is retained so
 * a future caller is still covered rather than losing the 403 contract.
 *
 * Exported so the #330 gauntlet SKIP set, the README, and the surface census
 * all classify against this one array.
 */
export const GATED_FAMILIES: readonly GatedFamily[] = [
  {
    id: 'browse-categories',
    label: '`/browse/categories*` (list, `{id}`, `{id}/playlists`)',
    pattern: /^\/browse\/categories(?:\/|$)/,
    example: '/browse/categories/party/playlists',
    tools: ['browse_category_deepdive'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'browse-new-releases',
    label: '`/browse/new-releases`',
    pattern: /^\/browse\/new-releases(?:\/|$)/,
    example: '/browse/new-releases',
    // No live call site: freshness and the "what just dropped" tools derive the
    // same answer from search + saved reads instead. Pattern retained for coverage.
    tools: [],
    fallback: 'replaced',
    reason: 'removal',
  },
  {
    id: 'markets',
    label: '`/markets`',
    pattern: /^\/markets$/,
    example: '/markets',
    tools: ['get_available_markets', 'market_validate'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'artist-top-tracks',
    label: '`/artists/{id}/top-tracks`',
    pattern: /^\/artists\/[^/]+\/top-tracks$/,
    example: '/artists/artist-id/top-tracks',
    tools: ['get_artist_top_tracks', 'queue_playlist'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'user-profile',
    label: '`/users/{id}` and `/users/{id}/playlists`',
    pattern: /^\/users\/[^/]+(?:\/.+)?$/,
    example: '/users/user-id',
    tools: ['get_user_profile', 'get_user_playlists', 'get_playlist_followers'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'me-type-contains',
    label: 'the documented `/me/{type}/contains` checks (tracks, albums, shows, episodes, audiobooks, following)',
    pattern: /^\/me\/(?:albums|tracks|episodes|shows|audiobooks|following)\/contains$/,
    example: '/me/episodes/contains',
    tools: ['check_episode_saved', 'remove_saved_episode', 'check_following_artists', 'restore_library_snapshot'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'playlist-followers-contains',
    label: '`/playlists/{id}/followers/contains`',
    pattern: /^\/playlists\/[^/]+\/followers\/contains$/,
    example: '/playlists/playlist-id/followers/contains',
    // #862 migrated check_playlist_following onto GET /me/library/contains,
    // which is NOT gated (it returned 200 on the same probe). Pattern retained
    // for coverage; no shipped tool reads this path any more.
    tools: [],
    fallback: 'replaced',
    reason: 'removal',
  },
  {
    id: 'batch-several',
    label: 'the multi-id `?ids=` batch endpoints (`/tracks`, `/albums`, `/artists`, `/episodes`, `/shows`, `/audiobooks`, `/chapters`)',
    // The bare plural path is the only form the wrapper sees -- per-id GETs go
    // through `/(tracks|...)/{id}` and are not gated, so the `$` anchor is
    // load-bearing (see isGatedPath tests).
    pattern: /^\/(?:tracks|albums|artists|episodes|shows|audiobooks|chapters)$/,
    example: '/tracks',
    tools: ['get_several_tracks', 'get_several_albums', 'get_several_artists'],
    fallback: 'replaced',
    reason: 'removal',
  },
];

/** The runtime classifier list, derived from the documented families above. */
export const GATED_PATH_PATTERNS: readonly RegExp[] = GATED_FAMILIES.map((f) => f.pattern);

/** Whether an API-relative request path belongs to the #329 gated class. */
export function isGatedPath(path: string): boolean {
  const bare = path.split('?')[0];
  return GATED_PATH_PATTERNS.some((re) => re.test(bare));
}

/**
 * The graceful 403 contract message: what gated means, that re-auth won't
 * help, and the grandfathered-credentials path. Spotify's own message (when
 * present and not the bare "Forbidden") is embedded verbatim so callers
 * still see the most accurate wire diagnostic.
 *
 * Exported for documentation and test fixtures. The wrapper itself no longer
 * raises an Error carrying this text (#765): it annotates the original
 * SpotifyApiError so callers that need the graceful prose can build it from
 * the annotated instance. Tool-level handlers render their own disclosures
 * (e.g. category_resolver emits `gated: true`, artist_collab_network emits
 * `top_tracks_available: false`).
 */
export function graceful403Message(path: string, err: SpotifyApiError): string {
  const spotifyMsg = err.message?.trim();
  const detail = spotifyMsg && spotifyMsg.toLowerCase() !== 'forbidden' ? ` -- ${spotifyMsg}` : '';
  return (
    `Spotify returned 403 for ${path}${detail}. ` +
    'This endpoint is on Spotify\u2019s app-registration-gated surface: a blanket ' +
    '\u201cForbidden\u201d with no reason field means the app registration itself cannot ' +
    'access it \u2014 it is not an OAuth scope problem, so re-running "spotify-mcp auth" ' +
    'or adding scopes will not help. Older grandfathered app registrations may still ' +
    'have access \u2014 see README \u201cRegistration-gated endpoints\u201d (README.md#registration-gated-endpoints) for the full list.'
  );
}

/** Annotations the gated-path wrapper attaches to the original SpotifyApiError (#765). */
interface GatedPathAnnotation {
  /** Always `true` on a gated-path 403; absent on every other error. */
  gatedSurface: true;
  /** The exact request path that gated, for callers that want to branch on it. */
  gatedPath: string;
}

/** Read the gated-path annotation off an error, returning undefined when absent. */
function gatedPathAnnotation(err: unknown): GatedPathAnnotation | undefined {
  if (!(err instanceof SpotifyApiError)) return undefined;
  const tagged = err as unknown as Partial<GatedPathAnnotation>;
  if (tagged.gatedSurface === true && typeof tagged.gatedPath === 'string') {
    return { gatedSurface: true, gatedPath: tagged.gatedPath };
  }
  return undefined;
}

/**
 * True when `err` is a SpotifyApiError that the gated-path wrapper annotated
 * as a 403 on a #329 registration-gated path (#765). This is the shared
 * detection helper for tool handlers that want to convert a gated 403 into a
 * graceful disclosure (category_resolver, artist_collab_network, market_validate).
 * Replaces per-tool copies that checked `err instanceof SpotifyApiError &&
 * err.status === 403`, which used to match the gated class only by accident
 * (the prior wrapper raised a plain Error, so those checks silently failed).
 */
export function isGatedError(err: unknown): err is SpotifyApiError {
  return gatedPathAnnotation(err) !== undefined;
}

type GetFn = (
  path: string,
  params?: Record<string, string>,
  opts?: { priority?: 'normal' | 'low' },
) => Promise<unknown>;

/** Install marker so a double installation never stacks wrappers. */
const INSTALL_FLAG = '__gatedPathContractInstalled__';

/**
 * True when `err` is the shape a removed Spotify endpoint answers with: a 403
 * (raw, or annotated as gated by the contract above), a 404, or a 410. Used
 * by tools that know one gated family is gone outright and has no replacement
 * (the #1013 /browse/categories family, browse_category_deepdive) so they can
 * name the removal instead of passing on a status that reads as a missing
 * object, an empty page, or a scope problem.
 *
 * After #765 the gated 403 is still a SpotifyApiError \u2014 only annotated \u2014
 * so the status check covers both raw and gated cases without needing a
 * separate `isGatedPathContractError` predicate.
 */
export function isRemovedEndpointFailure(err: unknown): boolean {
  return (
    err instanceof SpotifyApiError && (err.status === 403 || err.status === 404 || err.status === 410)
  );
}


/**
 * The single named installation point for the graceful-403 gating contract
 * (#791). Called from the client construction path in `src/index.ts`, so the
 * mapping is present in every host configuration -- no toolset trim, disable
 * override, or scope gate can take it away.
 *
 * Wraps `client.get` so 403s on gated-class paths are annotated and rethrown
 * (#765) instead of being replaced with a plain Error. Everything else --
 * other statuses, other paths, successful responses -- passes through
 * untouched. Because the wrapper is installed as an own property, internal
 * callers resolve it too (`getAllPages` walks pages via `this.get`), so
 * pagination over gated endpoints gets the same contract. Idempotent: a
 * second install on the same client is a no-op.
 */
export function installGatedPathContract(client: SpotifyClient): void {
  const marker = client as unknown as Record<string, unknown>;
  if (marker[INSTALL_FLAG]) return;
  const original = client.get.bind(client) as unknown as GetFn;
  const wrapped: GetFn = async (path, params, opts) => {
    try {
      return await original(path, params, opts);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 403 && isGatedPath(path)) {
        // #765: annotate and rethrow the original SpotifyApiError so callers
        // can keep branching on `err instanceof SpotifyApiError && err.status ===
        // 403`. Replacing the error type destroyed that check (category_resolver,
        // artist_collab_network, market_validate all rely on it), so the wrapper
        // now tags the instance and lets the tool handler decide what graceful
        // shape to produce from the same SpotifyApiError.
        (err as unknown as GatedPathAnnotation).gatedSurface = true;
        (err as unknown as { gatedPath: string }).gatedPath = path;
        throw err;
      }
      throw err;
    }
  };
  // Instance-level own property shadows the prototype method; internal
  // callers (getAllPages walks enqueue via `this.get`) resolve the wrapped
  // version too, so pagination over gated endpoints gets the same contract.
  (client as unknown as { get: GetFn }).get = wrapped;
  marker[INSTALL_FLAG] = true;
}
