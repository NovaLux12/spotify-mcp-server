/**
 * Central configuration loader for the SPOTIFY_MCP_* environment family.
 *
 * `loadConfig` is a pure function of an env object, so tests can pass their
 * own env instead of mutating process.env. The process-wide snapshot is read
 * ONCE at server startup via initConfig() (src/index.ts) and consumed through
 * getConfig(); tests may re-bind it with initConfig(fakeEnv).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface SpotifyMcpConfig {
  /** Default per-call truncation cap for list tools (#53). */
  maxItems: number;
  /** "Fetch everything" pagination cap (#55). */
  fetchAllCap: number;
  /** Token file path (same default as src/auth.ts TOKEN_FILE). */
  tokenFile: string;
  /** Active profile name (SPOTIFY_MCP_PROFILE). */
  profile: string | undefined;
  /** Browserless paste-flow auth gate (SPOTIFY_HEADLESS=1). */
  headless: boolean;
  /** OAuth redirect URI. */
  redirectUri: string;
  /** Opt-in mutation history JSONL logging (#64). */
  historyEnabled: boolean;
  /**
   * Per-request timeout in milliseconds for every outbound HTTP call
   * (API requests and token refresh) so a hung connection cannot stall the
   * serialized request queue forever (#109). Override with
   * SPOTIFY_REQUEST_TIMEOUT_MS.
   */
  spotifyRequestTimeoutMs: number;
  /** Per-call budget for freshness artist/show lookups (#242). */
  freshnessBudget: number;
  /** OAuth scopes override (SPOTIFY_SCOPES). Null = use the default profile. */
  scopes: string[] | null;
  /**
   * Name of the scope profile the effective scope set matches: a key of
   * SCOPE_PROFILES, or "custom" when SPOTIFY_SCOPES names a set no shipped
   * profile covers (#700). Null scopes resolve to the default profile.
   */
  scopeProfile: string;
  /** Default market fallback (SPOTIFY_MCP_MARKET). Null = not set / invalid. */
  market: string | null;
}

export const DEFAULT_MAX_ITEMS = 50;
export const DEFAULT_FETCH_ALL_CAP = 500;
export const DEFAULT_FRESHNESS_BUDGET = 25;

/** Default per-request HTTP timeout when SPOTIFY_REQUEST_TIMEOUT_MS is unset. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Known Spotify scope vocabulary — used to validate SPOTIFY_SCOPES (#221). */
export const KNOWN_SPOTIFY_SCOPES: ReadonlySet<string> = new Set([
  'ugc-image-upload',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-read-private',
  'user-read-email',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
  'app-remote-control',
  'streaming',
  // Keep complete — if Spotify adds a new scope, add it here so users can
  // request it without waiting for a doc update. Unknown scopes are rejected
  // with a named error at config load.
]);

// ---------------------------------------------------------------------------
// Scope profiles (#700)
//
// This table is the ONE source of truth for the scope vocabulary, the default
// request set and the profile names. src/auth.ts re-exports
// DEFAULT_SCOPES_LIST from it instead of carrying a second copy of the list
// (the two lists could and did drift), and `--scopes` accepts a profile name
// as the documented opt-in for mutation scopes.
// ---------------------------------------------------------------------------

/**
 * Scopes withheld from the default profile: every library, follow and playlist
 * write plus artwork upload. `user-follow-read` sits here because the
 * followed-artist list is only read to feed the follow write tools, so it is
 * requested alongside `user-follow-modify` rather than by default.
 */
export const MUTATION_SCOPES: ReadonlySet<string> = new Set([
  'user-library-modify',
  'user-follow-read',
  'user-follow-modify',
  'playlist-modify-public',
  'playlist-modify-private',
  'ugc-image-upload',
]);

/**
 * Email is a personal-data scope that belongs to no profile but `full`. Its
 * only shipped consumer is `get_me` (src/tools/catalog.ts), which surfaces
 * `me.email`; every other tool works without it.
 */
export const EMAIL_SCOPE = 'user-read-email';

/**
 * The default profile: identity reads plus playback control, which is the
 * action a control surface exists to perform. No library/follow/playlist
 * write, no artwork upload, no email.
 */
const CORE_SCOPES: readonly string[] = [
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
];

/** Named scope sets. `core` is the unconfigured default; the rest are opt-in. */
export const SCOPE_PROFILES: Readonly<Record<string, readonly string[]>> = {
  core: CORE_SCOPES,
  library: [...CORE_SCOPES, 'user-library-modify', 'user-follow-read', 'user-follow-modify'],
  playlists: [
    ...CORE_SCOPES,
    'playlist-modify-public',
    'playlist-modify-private',
    'ugc-image-upload',
  ],
  full: [...CORE_SCOPES, ...MUTATION_SCOPES, EMAIL_SCOPE],
};

/** Profile requested when SPOTIFY_SCOPES / --scopes are unset (#700). */
export const DEFAULT_SCOPE_PROFILE = 'core';

/** Default scope set — exactly what auth requests on a clean home. */
export const DEFAULT_SCOPES: readonly string[] = SCOPE_PROFILES[DEFAULT_SCOPE_PROFILE];

/** Profile names accepted wherever a scope list is accepted. */
export const SCOPE_PROFILE_NAMES: readonly string[] = Object.keys(SCOPE_PROFILES);

/** Whether `value` names a scope profile. */
export function isScopeProfileName(value: string): boolean {
  return Object.hasOwn(SCOPE_PROFILES, value);
}

/**
 * Name the profile `scopes` matches exactly, or "custom" when the set is not
 * one of the shipped profiles. An unset override resolves to the default
 * profile, so a clean run always reports a named profile.
 */
export function profileForScopes(scopes: readonly string[] | null | undefined): string {
  if (!scopes) return DEFAULT_SCOPE_PROFILE;
  const given = [...new Set(scopes)].sort();
  for (const [name, profile] of Object.entries(SCOPE_PROFILES)) {
    const candidate = [...new Set(profile)].sort();
    if (candidate.length === given.length && candidate.every((s, i) => s === given[i])) {
      return name;
    }
  }
  return 'custom';
}

/** Scope groups with the one-line rationale the auth banner prints per group. */
const SCOPE_GROUPS: readonly { group: string; scopes: readonly string[]; why: string }[] = [
  { group: 'identity', scopes: ['user-read-private'], why: 'read the profile behind the account' },
  { group: 'email', scopes: [EMAIL_SCOPE], why: 'read me.email (get_me)' },
  {
    group: 'playback',
    scopes: [
      'user-read-playback-state',
      'user-modify-playback-state',
      'user-read-currently-playing',
      'user-read-recently-played',
      'user-read-playback-position',
    ],
    why: 'see what is playing and drive the player',
  },
  { group: 'insights', scopes: ['user-top-read'], why: 'top artists and tracks' },
  { group: 'library-read', scopes: ['user-library-read'], why: 'read saved tracks and shows' },
  { group: 'library-write', scopes: ['user-library-modify'], why: 'save and remove library items' },
  { group: 'follows-read', scopes: ['user-follow-read'], why: 'read the followed-artist list' },
  { group: 'follows-write', scopes: ['user-follow-modify'], why: 'follow and unfollow artists' },
  {
    group: 'playlists-read',
    scopes: ['playlist-read-private', 'playlist-read-collaborative'],
    why: 'read private and collaborative playlists',
  },
  {
    group: 'playlists-write',
    scopes: ['playlist-modify-public', 'playlist-modify-private', 'ugc-image-upload'],
    why: 'create and edit playlists and upload cover art',
  },
  { group: 'remote', scopes: ['app-remote-control', 'streaming'], why: 'act as a Spotify Connect remote' },
];

/** Group + rationale for one scope; anything unrecognised lands in "other". */
export function scopeGroupFor(scope: string): { group: string; why: string } {
  for (const entry of SCOPE_GROUPS) {
    if (entry.scopes.includes(scope)) return { group: entry.group, why: entry.why };
  }
  return { group: 'other', why: 'requested explicitly' };
}

/** Parse a positive integer env value; anything else falls back to `fallback`. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Truthy env convention: "1", "true", "yes", "on" (case-insensitive). */
export function truthyEnv(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

/**
 * Validate a profile name: alphanumeric, dash, underscore, dot. Empty/undefined
 * yields undefined. Throws on invalid chars (sanitation for path injection).
 */
export function validateProfileName(raw: string | undefined): string | undefined {
  if (!raw || raw.trim() === '') return undefined;
  const name = raw.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      `Invalid SPOTIFY_MCP_PROFILE "${name}": must match [A-Za-z0-9._-]+`,
    );
  }
  // Prevent directory traversal
  if (name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`Invalid SPOTIFY_MCP_PROFILE "${name}": must not be "." or ".."`);
  }
  return name;
}

/**
 * Resolve token file path with precedence:
 * SPOTIFY_MCP_TOKEN_FILE (explicit) > SPOTIFY_MCP_PROFILE (namespaced) > default.
 * Exported for auth.ts to share the same resolution.
 */
export function resolveTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPOTIFY_MCP_TOKEN_FILE) return env.SPOTIFY_MCP_TOKEN_FILE;
  const profile = validateProfileName(env.SPOTIFY_MCP_PROFILE);
  if (profile) {
    return join(homedir(), '.spotify-mcp', `tokens.${profile}.json`);
  }
  return join(homedir(), '.spotify-mcp', 'tokens.json');
}

/**
 * Parse SPOTIFY_SCOPES / `--scopes`: space- or comma-separated, validated
 * against the known vocabulary, de-duplicated. A token naming a scope profile
 * (`core`, `library`, `playlists`, `full`) expands to that profile, so
 * `--scopes full` is the documented opt-in for mutation scopes (#700).
 * Returns null when unset. Throws on an unknown scope or profile.
 */
export function parseScopes(raw: string | undefined): string[] | null {
  if (!raw || raw.trim() === '') return null;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const s of parts) {
    if (seen.has(s)) continue;
    if (isScopeProfileName(s)) {
      for (const expanded of SCOPE_PROFILES[s]) {
        if (seen.has(expanded)) continue;
        seen.add(expanded);
        deduped.push(expanded);
      }
      continue;
    }
    if (!KNOWN_SPOTIFY_SCOPES.has(s)) {
      throw new Error(
        `Unknown scope in SPOTIFY_SCOPES: "${s}". Known scopes: ${[...KNOWN_SPOTIFY_SCOPES].sort().join(', ')}. Known profiles: ${SCOPE_PROFILE_NAMES.join(', ')}`,
      );
    }
    seen.add(s);
    deduped.push(s);
  }
  if (deduped.length === 0) return null;
  return deduped;
}

/**
 * Validate SPOTIFY_MCP_MARKET: ISO 3166-1 alpha-2, case-insensitive.
 * Returns uppercase code or null if unset. Warns and returns null if invalid.
 */
export function parseMarket(raw: string | undefined): string | null {
  if (!raw || raw.trim() === '') return null;
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    console.error(
      `[spotify-mcp] Invalid SPOTIFY_MCP_MARKET "${raw}": must be ISO 3166-1 alpha-2 (e.g. "US"). Ignoring.`,
    );
    return null;
  }
  return code;
}

/**
 * Resolve effective market with precedence:
 * explicit tool arg > SPOTIFY_MCP_MARKET (config) > account-country fallback > omitted.
 * The account-country fetch is supplied by the caller (null/undefined = omitted).
 */
export function resolveMarket(
  explicitMarket: string | undefined,
  configMarket: string | null | undefined,
  accountCountry: string | undefined,
): string | undefined {
  if (explicitMarket) return explicitMarket.toUpperCase();
  if (configMarket) return configMarket.toUpperCase();
  if (accountCountry) return accountCountry.toUpperCase();
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SpotifyMcpConfig {
  // SPOTIFY_SCOPES validation — let parseScopes throw with the offending scope named.
  const scopes = parseScopes(env.SPOTIFY_SCOPES);
  return {
    maxItems: positiveInt(env.SPOTIFY_MCP_MAX_ITEMS, DEFAULT_MAX_ITEMS),
    fetchAllCap: positiveInt(env.SPOTIFY_MCP_FETCH_ALL_CAP, DEFAULT_FETCH_ALL_CAP),
    tokenFile: resolveTokenFile(env),
    profile: validateProfileName(env.SPOTIFY_MCP_PROFILE),
    headless: truthyEnv(env.SPOTIFY_HEADLESS),
    redirectUri: env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback',
    historyEnabled: truthyEnv(env.SPOTIFY_MCP_HISTORY),
    spotifyRequestTimeoutMs: positiveInt(env.SPOTIFY_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    freshnessBudget: positiveInt(env.SPOTIFY_MCP_FRESHNESS_BUDGET, DEFAULT_FRESHNESS_BUDGET),
    scopes,
    scopeProfile: profileForScopes(scopes),
    market: parseMarket(env.SPOTIFY_MCP_MARKET),
  };
}

let current: SpotifyMcpConfig | null = null;

/** Read the env family once and install it as the process-wide snapshot. */
export function initConfig(env: NodeJS.ProcessEnv = process.env): SpotifyMcpConfig {
  current = loadConfig(env);
  return current;
}

/** Process-wide config snapshot, lazily initialized from process.env. */
export function getConfig(): SpotifyMcpConfig {
  return current ?? initConfig();
}
