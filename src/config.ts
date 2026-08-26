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
  /** OAuth scopes override (SPOTIFY_SCOPES). Null = use DEFAULT_SCOPES. */
  scopes: string[] | null;
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

/** Default scopes when SPOTIFY_SCOPES is unset — must match src/auth.ts DEFAULT_SCOPES. */
export const DEFAULT_SCOPES: readonly string[] = [
  'user-read-private',
  'user-read-email',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-read-playback-position',
  'user-top-read',
  'user-library-read',
  'user-library-modify',
  'user-follow-read',
  'ugc-image-upload',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-public',
  'playlist-modify-private',
];

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
 * Parse SPOTIFY_SCOPES: space- or comma-separated, validated against known
 * vocabulary, de-duplicated. Returns null when unset. Throws on unknown scope.
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
    if (!KNOWN_SPOTIFY_SCOPES.has(s)) {
      throw new Error(
        `Unknown scope in SPOTIFY_SCOPES: "${s}". Known scopes: ${[...KNOWN_SPOTIFY_SCOPES].sort().join(', ')}`,
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
