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
 * access keep working end to end -- only the broken path changes shape, and it
 * changes SHAPE only. A gated 403 is annotated in place and rethrown as the
 * same `SpotifyApiError` (#765), so the tool-level degradations written for
 * these endpoints (`category_resolver`, `artist_collab_network`,
 * `market_validate`, the catalog 403 messages) still recognise it.
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
 */
export function graceful403Message(path: string, err: SpotifyApiError): string {
  return graceful403Text(path, err.message);
}

function graceful403Text(path: string, wireMessage: string): string {
  const spotifyMsg = wireMessage?.trim();
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

/** A `SpotifyApiError` the contract has classified as registration-gated. */
export interface GatedSpotifyApiError extends SpotifyApiError {
  /** The API-relative path that answered 403. */
  readonly gatedPath: string;
  /** Spotify's own message, kept because `message` now carries the contract. */
  readonly spotifyMessage: string;
}

/**
 * THE 403 predicate every gated-path tool branches on. One definition, so a
 * tool that degrades a gated 403 and the contract that classifies it can
 * never disagree about what a gated 403 looks like (#765).
 */
export function isGatedError(err: unknown): err is SpotifyApiError {
  return err instanceof SpotifyApiError && err.status === 403;
}

/**
 * Classify a gated 403 ON THE INSTANCE and return it, so `instanceof`,
 * `status`, `reason` and `retryAfterSec` all survive the hop through this
 * contract (#765). Wrapping it in a plain `Error` -- the earlier shape --
 * left every tool-level 403 degradation unreachable: `category_resolver`,
 * `artist_collab_network`, `market_validate` and the two tailored catalog
 * messages all test `err instanceof SpotifyApiError && err.status === 403`,
 * so on a gated path they hard-failed instead of degrading.
 *
 * `message` becomes the graceful contract, because a gated 403 with no
 * tool-level handler (browse's `get_categories`, say) has nothing else to
 * report; Spotify's original text is preserved on `spotifyMessage` for
 * handlers that quote the wire message themselves.
 */
function annotateGated403(err: SpotifyApiError, path: string): GatedSpotifyApiError {
  // The wire text is read through `spotifyMessageOf`, never through
  // `err.message`, so a second hop cannot quote the contract inside itself.
  const wireMessage = spotifyMessageOf(err);
  return Object.assign(err, {
    spotifyMessage: wireMessage,
    gatedPath: path,
    message: graceful403Text(path, wireMessage),
  });
}

/**
 * Spotify's own message for a 403, whether or not the gating contract has
 * replaced `message` with the graceful contract text. Handlers that add their
 * own advice must quote this, not `err.message`, or they would embed a whole
 * second explanation inside their first sentence.
 */
export function spotifyMessageOf(err: SpotifyApiError): string {
  return 'spotifyMessage' in err && typeof err.spotifyMessage === 'string' ? err.spotifyMessage : err.message;
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
        throw annotateGated403(err, path);
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
