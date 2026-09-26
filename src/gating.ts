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
 *   /me/<type>/contains           -- albums/tracks/episodes/shows/audiobooks
 *   /me/following/contains        -- REMOVED by Spotify Feb 2026 (#594)
 *   /playlists/{id}/followers/contains -- likewise REMOVED Feb 2026 (#594)
 *
 * The last two families no longer exist as callable endpoints: every call
 * site migrated to the ungated `/me/library/contains` (#594), which is
 * deliberately absent from this set. The patterns are retained so a
 * grandfathered registration that still answers a removed path gets the
 * graceful 403 contract instead of a raw error.
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

type GetFn = (
  path: string,
  params?: Record<string, string>,
  opts?: { priority?: 'normal' | 'low' },
) => Promise<unknown>;

/** Install marker so a double installation never stacks wrappers. */
const INSTALL_FLAG = '__graceful403Installed__';

/**
 * Marker key set on the graceful-403 error `installGatedPathContract` throws.
 */
export const GATED_PATH_CONTRACT = Symbol.for('spotify-mcp.gatedPathContract');

/** True when `err` is the graceful-403 error `installGatedPathContract` raises. */
export function isGatedPathContractError(err: unknown): boolean {
  return err instanceof Error && (err as unknown as Record<symbol, unknown>)[GATED_PATH_CONTRACT] === true;
}

/**
 * True when `err` is the shape a removed Spotify endpoint answers with: a 403
 * (raw, or re-raised by the graceful contract above), a 404, or a 410. Used by
 * tools that know one gated family is gone outright and has no replacement, so
 * they can name the removal instead of passing on a status that reads as a
 * missing object, an empty page or a scope problem (#1013).
 */
export function isRemovedEndpointFailure(err: unknown): boolean {
  return (
    isGatedPathContractError(err) ||
    (err instanceof SpotifyApiError && (err.status === 403 || err.status === 404 || err.status === 410))
  );
}


/**
 * The single named installation point for the graceful-403 gating contract
 * (#791). Called from the client construction path in `src/index.ts`, so the
 * mapping is present in every host configuration -- no toolset trim, disable
 * override, or scope gate can take it away.
 *
 * Wraps `client.get` so 403s on gated-class paths short-circuit into the
 * graceful contract instead of the raw blanket "Forbidden". Everything else
 * -- other statuses, other paths, successful responses -- passes through
 * untouched. Because the wrapper is installed as an own property, internal
 * callers resolve it too (`getAllPages` walks pages via `this.get`), so
 * pagination over gated endpoints gets the same contract. Idempotent: a second
 * install on the same client is a no-op.
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
        const gated = new Error(graceful403Message(path, err), { cause: err });
        // Tag it so a caller with a sharper diagnosis for this gated family
        // (#1013: the removed browse categories) can recognise the shape
        // without matching on the message text -- the gated 403 never reaches
        // a tool as a SpotifyApiError.
        (gated as unknown as Record<symbol, boolean>)[GATED_PATH_CONTRACT] = true;
        throw gated;
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
