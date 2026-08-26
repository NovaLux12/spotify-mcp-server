/**
 * Toolsets (#95): coarse-grained grouping of registration entry points so an
 * operator can trim the server's exposed surface via
 * `SPOTIFY_MCP_TOOLSETS` (e.g. "playback,library" for a car dashboard, or
 * "catalog,personalization" for a read-only recommender). Unset/empty/'all'
 * keeps today's behaviour — everything registered.
 *
 * A set maps to REGISTRATION KEYS (the registerXxx call sites in index.ts),
 * not individual tool names: gating happens at registration time.
 *
 * Fine-grained opt-in/opt-out (#111 item 7): SPOTIFY_MCP_ENABLE_TOOLS /
 * SPOTIFY_MCP_DISABLE_TOOLS force individual registration keys on/off on top
 * of the set trim (disable wins over enable wins over set membership).
 */

/**
 * Registration key → toolset membership map. Every key registered in
 * index.ts must appear in at least one set so 'all' stays equivalent to the
 * ungated server.
 *
 * Sets and what they enable:
 *   playback        → tools/playback.ts        (15 tools)
 *   catalog         → tools/search.ts          (1 tool)
 *                     tools/catalog.ts         (18 tools)
 *                     tools/audiobooks.ts      (4 tools)  = 23 tools
 *   playlists       → tools/playlists.ts       (10 tools)
 *                     tools/users.ts           (2 tools)  = 12 tools
 *   library         → tools/library.ts         (10 tools)
 *                     tools/following.ts       (4 tools)  = 14 tools
 *   personalization → tools/personalization.ts (3 tools)
 *   resources       → resources/index.ts       (24 resources)
 *   prompts         → prompts/index.ts         (9 prompts)
 */
export const TOOLSETS: Record<string, readonly string[]> = {
  playback: ['playback'],
  catalog: ['search', 'catalog', 'audiobooks'],
  playlists: ['playlists', 'users'],
  library: ['library', 'following'],
  personalization: ['personalization'],
  resources: ['resources'],
  prompts: ['prompts'],
} as const;

/** Every registration key covered by at least one set ('all' semantics). */
const ALL_KEYS: readonly string[] = Object.values(TOOLSETS).flat();

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
 * - undefined / empty / whitespace-only → every set
 * - 'all' alone or mixed in ("catalog,all") → every set
 * - matching is case-insensitive ("Playback, LIBRARY" works)
 */
export function resolveToolsets(spec: string | undefined): { sets: Set<string>; unknown: string[] } {
  const names = Object.keys(TOOLSETS);
  const tokens = (spec ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  if (tokens.length === 0 || tokens.includes('all')) {
    return { sets: new Set(names), unknown: [] };
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
 * Set-membership-only variant of {@link isModuleActive} (no overrides).
 * Kept as the exported name used by existing call sites in index.ts.
 */
export function isActive(key: string, sets: Set<string>): boolean {
  return isModuleActive(key, sets);
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
 * explicitly disabled (same defensive default as {@link isActive}).
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
    `'all' or unset registers everything`
  );
}

// Re-exported for callers that want to sanity-check a spec's coverage
// without reaching into TOOLSETS' shape.
export { ALL_KEYS as allRegistrationKeys };
