/**
 * exhaust2 enggating slice -- the graceful-403 gating contract (#428, #429).
 *
 * This slice registers no new catalog surface. Its two issue assignments are
 * error-UX fixes over Spotify's app-registration-gated endpoint family
 * (issue #329, probed 2026-08-26 -- memory/edge-probe-2026-08-26.json):
 *
 *   #428 browse_403_graceful   -- get_categories / get_category /
 *                                get_category_playlists (and every other tool
 *                                over /browse/categories*) surfaced the raw
 *                                blanket "Forbidden" instead of an actionable
 *                                message.
 *   #429 gated_surface_selfflag -- the whole #329 gated class short-circuits
 *                                with the graceful 403 contract (pairs with
 *                                the #330 gauntlet SKIP set).
 *
 * Both are implemented at the single client choke point: this slice installs
 * a wrapper around the shared SpotifyClient's `get` (getAllPages walks route
 * through `this.get`, so one wrapper covers every paging helper). When
 * Spotify returns a 403 on a gated-class path, the raw SpotifyApiError is
 * rethrown as a graceful Error that:
 *   - names the endpoint path and Spotify's own message when present,
 *   - explains that a blanket "Forbidden" (no reason field) means the app
 *     registration itself is gated -- it is NOT an OAuth scope problem,
 *   - says explicitly that re-running "spotify-mcp auth" / adding scopes
 *     will NOT help,
 *   - points at the README "Registration-gated surface" list and the
 *     grandfathered-credentials path,
 *   - preserves the original error as `cause`.
 *
 * The contract is fail-open by design: apps whose registrations still have
 * access keep working end to end -- only the broken path changes shape.
 * Per-tool description warnings for the same class are owned by the
 * docs-gating slice (#329) so the two PRs never touch the same files.
 *
 * Slice conventions: all slice logic lives in this file and nowhere else;
 * tests in tests/exhaust2_enggating.test.ts.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError } from '../client.js';
import type { SpotifyClient } from '../client.js';

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
    'have access \u2014 see README \u201cRegistration-gated surface\u201d for the full list.'
  );
}

type GetFn = (
  path: string,
  params?: Record<string, string>,
  opts?: { priority?: 'normal' | 'low' },
) => Promise<unknown>;

/** Install marker so a double registration never stacks wrappers. */
const INSTALL_FLAG = '__graceful403Installed__';

/**
 * Wrap `client.get` so 403s on gated-class paths short-circuit into the
 * graceful contract instead of the raw blanket "Forbidden". Everything else
 * -- other statuses, other paths, successful responses -- passes through
 * untouched. Idempotent: a second install on the same client is a no-op.
 */
export function installGraceful403Contract(client: SpotifyClient): void {
  const marker = client as unknown as Record<string, unknown>;
  if (marker[INSTALL_FLAG]) return;
  const original = client.get.bind(client) as unknown as GetFn;
  const wrapped: GetFn = async (path, params, opts) => {
    try {
      return await original(path, params, opts);
    } catch (err) {
      if (err instanceof SpotifyApiError && err.status === 403 && isGatedPath(path)) {
        throw new Error(graceful403Message(path, err), { cause: err });
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

/**
 * Slice registration. Installs the graceful-403 gating contract (#428, #429)
 * on the shared client; this slice intentionally registers zero tools.
 */
export function registerExhaust2EnggatingTools(_server: McpServer, client: SpotifyClient): void {
  installGraceful403Contract(client);
}
