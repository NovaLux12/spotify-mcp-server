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
 * The #329 app-registration-gated endpoint families (probe 2026-08-26):
 *   /browse/categories*           -- list, single {id}, {id}/playlists (#428)
 *   /browse/new-releases          -- removed for newer registrations
 *   /markets                      -- app-gated
 *   /artists/{id}/top-tracks      -- app-gated
 *   /users/{id}*                  -- profile + playlists (Feb 2026 removal)
 *   documented /me/<type>/contains -- albums/tracks/episodes/shows/audiobooks/following
 *   /playlists/{id}/followers/contains
 *
 * Exported so the #330 gauntlet SKIP set and future callers classify against
 * the same single source of truth.
 */
export const GATED_PATH_PATTERNS: readonly RegExp[] = [
  /^\/browse\/categories(?:\/|$)/,
  /^\/browse\/new-releases(?:\/|$)/,
  /^\/markets$/,
  /^\/artists\/[^/]+\/top-tracks$/,
  /^\/users\/[^/]+(?:\/.+)?$/,
  /^\/me\/(?:albums|tracks|episodes|shows|audiobooks|following)\/contains$/,
  /^\/playlists\/[^/]+\/followers\/contains$/,
];

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
