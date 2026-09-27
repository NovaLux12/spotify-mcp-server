/**
 * The app-registration-gated error contract (#791, #428, #429; audit
 * A14-016/A8-036) -- the graceful 403 mapping for Spotify's
 * app-registration-gated endpoint family, classified from Spotify's
 * February 2026 changelog and its endpoint reference pages.
 *
 * The classification below rests on two citable sources, not on a local run:
 *
 *   - Spotify's February 2026 changelog
 *     (https://developer.spotify.com/documentation/web-api/references/changes/february-2026),
 *     which marks every operation in `GATED_FAMILIES` `[REMOVED]` and names
 *     the replacements (`/me/library`, `/me/library/contains`, `/items`).
 *     This is the basis for every `reason: 'removal'` row below.
 *   - The endpoint reference pages, spot-checked 2026-09-27. They do NOT
 *     agree with the changelog, and the disagreement is the point rather than
 *     a problem with this table: `/browse/categories` and `/markets` are still
 *     published and marked "Deprecated", as are the seven `Get Several`
 *     batch paths, while `/artists/{id}/top-tracks` now 404s. So a row here
 *     means "the changelog removed it", not "the docs deleted it" -- which is
 *     why `reason` and `fallback` are separate fields, and why the runtime
 *     truth is still what a given registration is allowed to read.
 *
 * An earlier version of this header cited a dated probe artefact under
 * `memory/` as the evidence for this whole contract (#1260). That file is not
 * in the repository and never was: `.gitignore` excludes `memory/*` apart from
 * three whitelisted sweep reports, so the probe wrote its result to a path git
 * silently dropped. `scripts/edge-probe.mjs` still defaults its output there,
 * which is where the phantom citation came from. Nothing was re-derived when
 * the citation was removed: every family below is marked `[REMOVED]` in the
 * changelog, so the probe had nothing to add that a citable source does not
 * already say. The raw run stays uncommitted by design; it hits a live
 * Spotify API and is a deliberate, occasional act, not something to redo in
 * a docs change, and committing a stale run would only freeze a snapshot that
 * ages. A citation a reader cannot follow is worse than none, so the citation
 * now names a URL that resolves.
 *
 * Re-verify both sources before trusting a row: Spotify removed a batch of
 * endpoints within months of this repo last calling a family "verified
 * operational" (AGENTS.md §2).
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
 * The #329 app-registration-gated endpoint families, classified from
 * Spotify's February 2026 changelog (see the file header for the URLs and the
 * re-verification date). Not from a local run: the earlier "probe 2026-08-26"
 * citation pointed at a JSON artefact that is not in the repository (#1260).
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
 * tool calls it. Three families (`browse-new-releases`,
 * `playlist-followers-contains`, `me-type-contains`) have no live call site
 * left -- the tools that used them were migrated onto replacements or deleted
 * -- and the pattern is retained so a future caller is still covered rather
 * than losing the 403 contract.
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
    // #1278: the census cross-checks this column PER TOOL, so this list is the
    // real set rather than the set of files that happen to contain a call.
    // `get_category` and `browse_category_deepdive` reach the family through a
    // local `categoryPath` variable rather than a `client.get` literal, and
    // `category_resolver` is the one caller in `exhaust2_catalog.ts`; all three
    // were invisible to the previous per-FILE scan, which was satisfied by any
    // one of them.
    tools: ['get_category', 'browse_category_deepdive', 'category_resolver'],
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
    // #1278: cross-checked per tool, so this is every shipped tool that issues
    // the read, not every file that contains one. The `playlistbatch` trio all
    // reach it through the module-level `resolveSourceUris` helper, and
    // `queue_playlist` through `resolveUris` — the previous per-FILE scan read
    // all three as satisfied by whichever call happened to be in the file.
    // `get_artist_top_tracks` is the one caller the scan cannot see: it hands
    // its path to `getWithMarketFallback` in `src/markets.ts`, outside the
    // scanned tree. That is declared in `GATED_SCAN_EXCEPTIONS` in
    // `scripts/surface-census.mjs`, which is also what fails if the wrapper
    // ever moves into the tree and the tolerance goes stale.
    tools: [
      'get_artist_top_tracks',
      'queue_playlist',
      'artist_collab_network',
      'artist_completeness_score',
      'batch_add_to_playlist',
      'copy_playlist',
      'move_items_between_playlists',
    ],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'user-profile',
    label: '`/users/{id}` and `/users/{id}/playlists`',
    pattern: /^\/users\/[^/]+(?:\/.+)?$/,
    example: '/users/user-id',
    // #638: `get_user_playlists` was dropped from this list. Despite the name
    // it reads `GET /me/playlists` — the authenticated user's own playlists —
    // which Spotify never removed, so listing it here claimed a call site that
    // does not exist and would have sent a future reader looking for a
    // migration that was never needed. Since #1278 the census cross-checks
    // this column per TOOL, in both directions, so that substitution cannot
    // come back silently: a tool here with no call behind it fails, and so does
    // a call behind a tool this family does not name.
    tools: ['get_user_profile', 'get_user_playlists_by_id', 'get_playlist_followers'],
    fallback: 'explained',
    reason: 'removal',
  },
  {
    id: 'me-type-contains',
    label: 'the documented `/me/{type}/contains` checks (tracks, albums, shows, episodes, audiobooks, following)',
    pattern: /^\/me\/(?:albums|tracks|episodes|shows|audiobooks|following)\/contains$/,
    example: '/me/episodes/contains',
    // #638: no live call site. `GET /me/library/contains` is NOT in the gated
    // class -- it answered 200 on the same 2026-08-26 probe that 403'd these --
    // so every reader was moved onto it: `check_episode_saved` /
    // `remove_saved_episode` / `remove_saved_shows` (swarm3_shows.ts),
    // `check_following_artists` (following.ts) and `restore_library_snapshot`
    // (restore.ts). `check_saved_items` was the last reader of this family and
    // was deleted outright rather than pointed at the replacement: it was a
    // strict subset of `check_in_library` and carried the same dead rationale.
    // Pattern retained for coverage.
    tools: [],
    fallback: 'replaced',
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
    // #1278: every one of the seven `get_several_*` tools reads this family
    // through the shared `fetchSeveral` helper, and `catalog_batch_lookup`
    // reaches the same helper for every URI type it partitions — so all eight
    // callers belong here. The previous column named three, and the per-FILE
    // scan could not notice: they all sit in one file with one call site.
    tools: [
      'get_several_tracks',
      'get_several_albums',
      'get_several_artists',
      'get_several_episodes',
      'get_several_shows',
      'get_several_audiobooks',
      'get_several_chapters',
      'catalog_batch_lookup',
    ],
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
