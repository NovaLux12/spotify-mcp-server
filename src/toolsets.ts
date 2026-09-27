/**
 * Toolsets (#95): coarse-grained grouping of registration entry points so an
 * operator can trim the server's exposed surface via
 * `SPOTIFY_MCP_TOOLSETS` (e.g. "playback,library" for a car dashboard, or
 * "catalog,personalization" for a read-only recommender).
 *
 * The DEFAULT is curated, not everything (#889): unset used to register the whole
 * registry — ~600 KB of schema — before the host's first user message. Unset now
 * registers {@link DEFAULT_TOOLSETS}; `SPOTIFY_MCP_TOOLSETS=all` is the
 * documented way back to the full surface, so this is a default change and not
 * a removal.
 *
 * A set maps to REGISTRATION KEYS (the registerXxx call sites in index.ts),
 * not individual tool names: gating happens at registration time.
 *
 * Fine-grained opt-in/opt-out (#111 item 7): SPOTIFY_MCP_ENABLE_TOOLS /
 * SPOTIFY_MCP_DISABLE_TOOLS force individual registration keys on/off on top
 * of the set trim (disable wins over enable wins over set membership).
 */

// BEGIN:generated surface-census
// Production surface (generated; run `npm run count:tools -- --write` after registry changes):
// 561 tools, 17 fixed resources, 47 resource templates, and 14 prompts.
// END:generated surface-census

/**
 * Registration key → toolset membership map. Every key registered in
 * index.ts must appear in at least one set so 'all' stays equivalent to the
 * ungated server.
 *
 * Sets and what they enable:
 *   core            → search + playback + playlists (+batch/misc) + library + following + users
 *                     (smallest set that still covers the daily loop)
 *   playback        → tools/playback.ts         (playback controls/state)
 *                     tools/queueops.ts         (queue_playlist + save_queue_as_playlist)
 *                     tools/playbackext.ts      (save/restore playback, device presets, sessions)
 *                     tools/playbackintel.ts    (queue/context/volume/market intel)
 *                     tools/scenes.ts           (save/apply/list/delete scene + wind-down)
 *                     tools/exhaust2_playback.ts, tools/swarm3_playback.ts (playback state/queue/bookmarks)
 *   playbackintel   → tools/playbackintel.ts    (queue/context/volume/market intel) — standalone, also enabled via playback
 *   catalog         → tools/search.ts           (search)
 *                     tools/catalog.ts          (catalog and typed search)
 *                     tools/audiobooks.ts       (audiobook browse)
 *                     tools/browse.ts           (artist genres + browse categories)
 *                     tools/artistwatch.ts      (discography/watchlist)
 *                     tools/searchhistory.ts    (search history)
 *                     tools/exhaust2_catalog.ts, tools/exhaust2_enggating.ts, tools/swarm3_discovery.ts, tools/swarm3b_discovery.ts, tools/swarm3_shows.ts, tools/swarm3_refs.ts, tools/swarm3_meta.ts (discovery/catalog deep-dives)
 *   playlists       → tools/playlists.ts        (playlist read/write)
 *                     tools/users.ts            (user profiles)
 *                     tools/playlisthealth.ts   (health/followers/collab/snapshots)
 *                     tools/playlistbatch.ts    (batch add/copy/move)
 *                     tools/playlistmisc.ts     (pin/unpin/templates)
 *                     tools/exhaust2_playlists.ts, tools/exhaust2_extra.ts, tools/swarm3_playlistops.ts, tools/swarm3_snapshots.ts, tools/swarm4_playlists.ts (playlist set-ops/snapshot/resequence)
 *   library         → tools/library.ts          (saved-library read/write)
 *                     tools/following.ts        (artist/playlist following)
 *                     tools/libraryanalytics.ts (coverage/heatmap/growth/genre trends)
 *                     tools/portability.ts      (weekly/radar save + full export)
 *                     tools/episodemgmt.ts      (archive/mark episodes)
 *                     tools/exhaust2_misc.ts, tools/swarm3_library.ts (library hygiene)
 *   personalization → tools/personalization.ts (top artists/tracks/recently played) + tools/swarm3_analytics.ts (listening analytics)
 *   statsfm         → tools/statsfm.ts          (third-party stats.fm API, read-only)
 *   taste           → tools/statsfm_taste.ts    (canonical statsfm_taste_* tools: stats.fm taste intelligence, read-only, no auth)
 *                     tools/taste_composites.ts (composites, no auth; read-only except taste_to_playlist, which writes only when dry_run=false)
 *   discovery       → tools/swarm3_meta.ts      (find_tool, inspect_tool, toolset_report) — also in catalog for compat
 *   accounts        → tools/accounts.ts         (list_accounts + switch_account) — also in core
 *   resources       → resources/index.ts        (template and standard resources)
 *   prompts         → prompts/index.ts          (workflow prompts)
 */
export const TOOLSETS: Record<string, readonly string[]> = {
  // The day-to-day surface: search, playback controls, playlist read/write,
  // library read/write, following. This is the DEFAULT (#889) — a server started
  // with no env registers this and nothing else. Discovery tools and
  // spotify_doctor register unconditionally.
  //
  // `statsfm` was here until #607. It is a third-party API needing a separate
  // stats.fm username, and it was 30 tools of the default list that fail or
  // return nothing for every user who has not configured STATSFM_USER_ID.
  // `SPOTIFY_MCP_TOOLSETS=taste,statsfm` or `SPOTIFY_MCP_STATSFM=1` brings it
  // back.
  core: ['search', 'playback', 'playlists', 'playlistbatch', 'playlistmisc', 'library', 'following', 'users', 'portability', 'swarm3meta', 'accounts'],
  playback: ['playback', 'queueops', 'playbackext', 'playbackintel', 'exhaust2playback', 'swarm3playback'],
  playbackintel: ['playbackintel'],
  catalog: ['search', 'catalog', 'audiobooks', 'browse', 'artistwatch', 'searchhistory', 'exhaust2catalog', 'exhaust2enggating', 'swarm3discovery', 'swarm3bdiscovery', 'swarm3shows', 'swarm3refs', 'swarm3meta'],
  playlists: ['playlists', 'users', 'playlisthealth', 'playlistbatch', 'playlistmisc', 'exhaust2playlists', 'exhaust2extra', 'swarm3playlistops', 'swarm3snapshots', 'swarm4playlists'],
  library: ['library', 'following', 'libraryanalytics', 'portability', 'episodemgmt', 'exhaust2misc', 'swarm3library'],
  personalization: ['personalization', 'swarm3analytics'],
  statsfm: ['statsfm'],
  portability: ['portability'],
  taste: ['taste', 'tastecomposites'],
  discovery: ['swarm3meta'],
  resources: ['resources'],
  prompts: ['prompts'],
  // #602. Its own set as well as membership in `core`: an operator who trims to
  // one surface still needs to be able to ask which account the session is
  // acting as, and a question about identity does not belong to any one of the
  // surfaces being trimmed.
  accounts: ['accounts'],
} as const;

/** Every registration key covered by at least one set ('all' semantics). */
const ALL_KEYS: readonly string[] = Object.values(TOOLSETS).flat();

/**
 * The sets registered when `SPOTIFY_MCP_TOOLSETS` is unset, empty, or
 * whitespace (#889).
 *
 * Unset used to mean "everything", which meant the first `tools/list` a host
 * saw carried the entire registry — ~600 KB of schema — before the user had
 * typed anything. `SPOTIFY_MCP_TOOLSETS=all` is the documented way back to the
 * full surface, so this is a default change and not a removal: nothing an
 * operator can reach today becomes unreachable, and the payload a host pays per
 * session drops by roughly three quarters.
 *
 * `resources` and `prompts` are in the default because they cost no tool-schema
 * context — they are separate MCP surfaces, none of which appear in the tool
 * budget. Trimming them would take away real capabilities and buy back nothing.
 * Their counts are the generated block above, not a hand-typed figure: main
 * moves them, and this comment once went stale quoting a fork-point number.
 *
 * The set names are validated against {@link TOOLSETS} rather than trusted, so
 * a typo here fails a test instead of silently registering less than intended.
 */
export const DEFAULT_TOOLSETS: readonly string[] = Object.freeze(['core', 'resources', 'prompts']);

/**
 * The registration keys that make up the stats.fm surface (#607).
 *
 * Listed here rather than in `index.ts` because this is a property of the
 * toolset map — the names are only valid because they appear in
 * {@link TOOLSETS} — and `tests/toolsets.test.ts` checks every entry against
 * `allRegistrationKeys`. A key that drifts out of the map fails there.
 *
 * `taste_playlist` is absent because it is not a registration key: its manifest
 * entry registers under `tastecomposites`, so enabling that key brings it along.
 */
export const STATSFM_REGISTRATION_KEYS: readonly string[] = Object.freeze([
  'statsfm',
  'taste',
  'tastecomposites',
]);

/** Reverse index: registration key → the sets that enable it. */
const KEY_TO_SETS: Record<string, readonly string[]> = (() => {
  const map: Record<string, string[]> = {};
  for (const [set, keys] of Object.entries(TOOLSETS)) {
    for (const key of keys) {
      (map[key] ??= []).push(set);
    }
  }
  return map;
})();

/**
 * Parse a comma-separated toolset spec into the set of ACTIVE SET NAMES plus
 * any unrecognized names. Never throws: unknown names are collected so the
 * caller can warn; they simply don't activate anything.
 *
 * - undefined / empty / whitespace-only → {@link DEFAULT_TOOLSETS} (#889)
 * - 'all' alone or mixed in ("catalog,all") → every set
 * - matching is case-insensitive ("Playback, LIBRARY" works)
 */
export function resolveToolsets(spec: string | undefined): { sets: Set<string>; unknown: string[] } {
  const names = Object.keys(TOOLSETS);
  const tokens = (spec ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  // `all` is checked BEFORE the empty case, not after: "catalog,all" must still
  // be the whole surface, and it is the only way back to it now that unset
  // means the curated default.
  if (tokens.includes('all')) {
    return { sets: new Set(names), unknown: [] };
  }

  if (tokens.length === 0) {
    return { sets: new Set(DEFAULT_TOOLSETS), unknown: [] };
  }

  const known: Record<string, true> = {};
  for (const n of names) known[n.toLowerCase()] = true;
  const sets = new Set<string>();
  const unknown: string[] = [];
  for (const token of tokens) {
    if (Object.hasOwn(known, token)) sets.add(token);
    else unknown.push(token);
  }
  return { sets, unknown };
}

/**
 * Fail-loud guard for SPOTIFY_MCP_TOOLSETS (#910): an unknown-only spec
 * (non-empty, no 'all', zero known sets) throws naming the valid sets via
 * {@link toolsetEnvHelp}; everything else (unset/empty/whitespace/'all'/
 * mixed known+unknown) stays non-fatal so callers keep today's behaviour.
 * Does not change {@link resolveToolsets}' return shape.
 */
export function assertToolsetsUsable(
  envValue: string | undefined,
  resolved: { sets: Set<string>; unknown: string[] },
): void {
  const tokens = (envValue ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.includes('all')) return;
  if (resolved.sets.size === 0) {
    throw new Error(
      `[spotify-mcp] SPOTIFY_MCP_TOOLSETS=${JSON.stringify(envValue)} matches no known toolset (unknown: ${resolved.unknown.join(', ')}) — ${toolsetEnvHelp()}`,
    );
  }
}

/**
 * Per-tool opt-in/opt-out (#111 item 7), layered on top of the toolset trim.
 * Parses two comma-separated lists of REGISTRATION KEYS from env-driven specs:
 *
 *   SPOTIFY_MCP_ENABLE_TOOLS  → force a module active even if its set was trimmed
 *   SPOTIFY_MCP_DISABLE_TOOLS → force a module hidden even if its set is active
 *
 * Precedence (see {@link isModuleActive}): disable beats enable beats set
 * membership. Unknown keys are collected so the caller can warn, mirroring
 * {@link resolveToolsets}; they never activate or deactivate anything.
 */
export function resolveToolOverrides(
  enableSpec: string | undefined,
  disableSpec: string | undefined,
): {
  enable: Set<string>;
  disable: Set<string>;
  unknown: { enable: string[]; disable: string[] };
} {
  const known: Record<string, true> = {};
  for (const k of ALL_KEYS) known[k.toLowerCase()] = true;

  const parse = (
    spec: string | undefined,
    bucket: Set<string>,
    misses: string[],
  ): void => {
    for (const token of (spec ?? '').split(',')) {
      const t = token.trim().toLowerCase();
      if (t.length === 0) continue;
      if (Object.hasOwn(known, t)) bucket.add(t);
      else misses.push(t);
    }
  };

  const enable = new Set<string>();
  const disable = new Set<string>();
  const unknown = { enable: [] as string[], disable: [] as string[] };
  parse(enableSpec, enable, unknown.enable);
  parse(disableSpec, disable, unknown.disable);
  return { enable, disable, unknown };
}

/**
 * Whether registration key `key` is active under the resolved toolsets plus
 * per-key overrides: `overrides.disable` wins over `overrides.enable`, which
 * wins over set membership. Keys not covered by any set stay active unless
 * explicitly disabled.
 *
 * The overrides argument is optional because it is the only reason there was
 * ever a second name for this function. `isActive(key, sets)` was that alias —
 * set membership with no overrides — and it had no production caller: the
 * doctor resolved overrides and passed them (#581), so nothing was left to
 * call it. It is deleted rather than kept, because an alias that silently
 * ignores overrides is a second answer to "is this module active?".
 */
export function isModuleActive(
  key: string,
  sets: Set<string>,
  overrides?: { enable: Set<string>; disable: Set<string> },
): boolean {
  const lk = key.toLowerCase();
  if (overrides?.disable.has(lk)) return false;
  if (overrides?.enable.has(lk)) return true;
  const owners = KEY_TO_SETS[key];
  if (!owners) return true;
  return owners.some((set) => sets.has(set));
}

/** One-line summary of the available sets, for doctor/startup output. */
export function toolsetEnvHelp(): string {
  const names = Object.keys(TOOLSETS).join(',');
  return (
    `SPOTIFY_MCP_TOOLSETS=<sets> — comma-separated subsets of ${names}; ` +
    `unset registers the default (${DEFAULT_TOOLSETS.join(',')}), 'all' registers everything. ` +
    `Unknown-only specs fail startup; mixed specs ignore unknown names.`
  );
}

// Re-exported for callers that want to sanity-check a spec's coverage
// without reaching into TOOLSETS' shape.
export { ALL_KEYS as allRegistrationKeys };