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
  /**
  /**
   * How many requests a tool-side fan-out may have in flight at once (#783).
   * Bounded parallelism, not a rate limit: the request count is unchanged.
   * Yields to SPOTIFY_MCP_MAX_CONCURRENCY, the request funnel's own width
   * (#892), when that is set; otherwise SPOTIFY_MCP_FANOUT_CONCURRENCY.
   */
  fanoutConcurrency: number;
  /** Which knob supplied fanoutConcurrency, for the disclosure the tools emit. */
  fanoutConcurrencySource: string;
  /**
   * How many Spotify API requests the request funnel keeps in flight at once
   * (#892). This is THE process-wide width: every request passes through the
   * funnel, including those a tool-side fan-out issues. The funnel still paces
   * starts a minimum 100 ms apart and still stops every start during a
   * `Retry-After` cooldown; this is the ceiling on how many of those paced
   * requests may be open simultaneously. `1` restores the strictly serial
   * funnel of v1.
   */
  maxConcurrency: number;
  /** OAuth scopes override (SPOTIFY_SCOPES). Null = use DEFAULT_SCOPES. */
  scopes: string[] | null;
  /** Default market fallback (SPOTIFY_MCP_MARKET). Null = not set / invalid. */
  market: string | null;
  /**
   * Hard read-only mode (SPOTIFY_MCP_READONLY) — the same value the
   * registration gate acts on, read through the same `readOnlyEnv` (#611).
   *
   * It lives on the snapshot rather than being re-read by the reporter so that
   * doctor cannot print a flag state the registry did not use: one parse, one
   * value, two readers. See `readOnlyModeEnabled` in src/tools/annotations.ts.
   */
  readonly: boolean;
}

export const DEFAULT_MAX_ITEMS = 50;
export const DEFAULT_FETCH_ALL_CAP = 500;
export const DEFAULT_FRESHNESS_BUDGET = 25;

/**
/**
 * Default fan-out width for the freshness-radar walks (#783), used only when
 * neither knob is set.
 *
 * Note that `resolveFanoutConcurrency` prefers SPOTIFY_MCP_MAX_CONCURRENCY,
 * which always resolves — to 3 when unset. This constant is therefore reached
 * only when that preference is bypassed, and a scan that resolves through it
 * while the funnel allows 3 would report a width of 4 that cannot occur; see
 * the precedence note on `resolveFanoutConcurrency`.
 */
export const DEFAULT_FANOUT_CONCURRENCY = 4;

/**
 * Default ceiling on in-flight Spotify requests (#892). Three keeps the 100 ms
 * pacing gap meaningful — a 250 ms Spotify request still overlaps its
 * successors — while staying far below anything Spotify or a host would
 * object to.
 */
export const DEFAULT_MAX_CONCURRENCY = 3;

/**
 * Hard ceiling for SPOTIFY_MCP_MAX_CONCURRENCY. Unbounded concurrency is the
 * exact failure mode this knob exists to bound, so the ceiling is enforced
 * here rather than trusted from the environment.
 */
export const MAX_CONCURRENCY_CEILING = 32;

/** Default per-request HTTP timeout when SPOTIFY_REQUEST_TIMEOUT_MS is unset. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The OAuth scope vocabulary (#618) — the SINGLE SOURCE for this repo.
 *
 * There were two hand-maintained copies (this one and a second beside the auth
 * flow) that were equal only by hand. A scope added to one side produced a
 * startup error that named the other side's file, and a scope removed from one
 * was still requested at auth and rejected at config load. The failure surfaced
 * as a crash unrelated to the edit that caused it, which is how a one-line
 * vocabulary change reads as a config bug.
 *
 * Both lists are now derived from ONE array, so there is nothing to keep in
 * step: the defaults are a subset, and the known set is the defaults plus the
 * opt-ins. `src/auth.ts` imports both — it no longer holds a copy.
 *
 * Order is the order the consent screen shows, and it is meaningful only in
 * that sense. `KNOWN_SPOTIFY_SCOPES` is a Set, so nothing depends on its order.
 *
 * Keep this complete as Spotify adds scopes: an unknown scope is rejected with
 * a named error at config load, so a scope missing here cannot be requested at
 * all until this file changes.
 */
const SCOPE_VOCABULARY = {
  /**
   * Requested when SPOTIFY_SCOPES is unset (17 scopes). The consent prompt
   * shows exactly this set, so adding a scope here widens what every user is
   * asked to approve — which is why `ugc-image-upload` is present (the cover
   * upload tool needs it) and `streaming` is not (it is for the browser Web
   * Playback SDK, not the Web API).
   */
  default: [
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
  ],
  /**
   * Accepted in SPOTIFY_SCOPES and `auth --scopes`, never requested by
   * default. Both are legitimate Web API scopes that most operators do not
   * want in the standing grant, so they are opt-in rather than excluded.
   */
  optIn: ['app-remote-control', 'streaming'],
} as const satisfies Record<string, readonly string[]>;

export type KnownScope =
  | (typeof SCOPE_VOCABULARY.default)[number]
  | (typeof SCOPE_VOCABULARY.optIn)[number];

/** Default scopes when SPOTIFY_SCOPES is unset — the standing consent grant. */
export const DEFAULT_SCOPES: readonly KnownScope[] = SCOPE_VOCABULARY.default;

/** Every scope SPOTIFY_SCOPES / `auth --scopes` will accept (#221). */
export const KNOWN_SPOTIFY_SCOPES: ReadonlySet<KnownScope> = new Set<KnownScope>([
  ...SCOPE_VOCABULARY.default,
  ...SCOPE_VOCABULARY.optIn,
]);

/**
 * Narrow an arbitrary string to the vocabulary. The parsers receive whatever
 * an operator typed, so the test has to accept a plain `string`; the guard is
 * what lets a validated scope be used where a `KnownScope` is required without
 * a cast at each call site.
 */
export function isKnownScope(candidate: string): candidate is KnownScope {
  return KNOWN_SPOTIFY_SCOPES.has(candidate as KnownScope);
}

/** Parse a positive integer env value; anything else falls back to `fallback`. */
function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The boolean env convention (#611), as data rather than a literal buried in
 * each call site.
 *
 * The asymmetry is deliberate and is the whole reason this is shared: an
 * opt-IN flag (`SPOTIFY_MCP_READONLY`) is true when the value is in TRUTHY,
 * while an opt_OUT flag (`SPOTIFY_MCP_SEARCH_HISTORY`, on unless disabled) is
 * false when the value is in FALSY. Both tables name the same four words in
 * opposite senses, so a reader that grabs the wrong one inverts a safety
 * switch — `SPOTIFY_MCP_READONLY=off` must not mean "read-only ON".
 *
 * Naming both also gives `unrecognisedBooleanEnv` something to test against,
 * which is how a typo gets a warning instead of silence.
 */
export const TRUTHY_ENV_VALUES: readonly string[] = ['1', 'true', 'yes', 'on'];
export const FALSY_ENV_VALUES: readonly string[] = ['0', 'false', 'no', 'off'];

/** Truthy env convention: "1", "true", "yes", "on" (case-insensitive, trimmed). */
export function truthyEnv(raw: string | undefined): boolean {
  return TRUTHY_ENV_VALUES.includes((raw ?? '').trim().toLowerCase());
}

/**
 * Falsy env convention for opt-out flags: "0", "false", "no", "off"
 * (case-insensitive, trimmed). The complement of `truthyEnv` in the sense that
 * matters: an UNRECOGNISED value is neither, which is what lets a typo be told
 * apart from a deliberate choice.
 */
export function falsyEnv(raw: string | undefined): boolean {
  return FALSY_ENV_VALUES.includes((raw ?? '').trim().toLowerCase());
}

/**
 * Whether `raw` names no boolean at all — a value that is neither truthy nor
 * falsy, so the caller that wants a decision must supply a default and the
 * caller that wants a warning can fire one.
 *
 * Unset and empty are NOT unrecognised: "the operator did not set this" is a
 * complete answer, and warning on it would fire on every process start.
 */
export function unrecognisedBooleanEnv(raw: string | undefined): boolean {
  const normalised = (raw ?? '').trim().toLowerCase();
  if (normalised === '') return false;
  return !TRUTHY_ENV_VALUES.includes(normalised) && !FALSY_ENV_VALUES.includes(normalised);
}

/**
 * The single reader of SPOTIFY_MCP_READONLY (#611).
 *
 * This flag is the hard read-only guarantee: it hides every write-capable
 * registration module, so an operator who sets it and does not get it is
 * running a write-capable server while believing otherwise. It previously had
 * its own three-value list with no trim and no `on`, in a different file from
 * the parser the rest of the config surface used — so `SPOTIFY_MCP_READONLY=on`
 * was silently ignored, and the flag appeared in no validation or diagnostic
 * path at all.
 *
 * Exported from config.ts rather than from the tool layer because the
 * disclosure (doctor) and the gate (module registration) must not be able to
 * disagree; see `readOnlyModeEnabled` in src/tools/annotations.ts, the only
 * consumer, and the `readonly` field on the config snapshot it reads.
 */
export function readOnlyEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return truthyEnv(env.SPOTIFY_MCP_READONLY);
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
 *
 * A variable that is set but names no scope throws rather than reading as
 * "unset" (#617): the old fall-through silently substituted DEFAULT_SCOPES, so
 * `SPOTIFY_SCOPES=" "` requested all 17 scopes — every mutation scope — where
 * the operator had asked for the narrowest set. Unset it instead of emptying it.
 */
export function parseScopes(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      'SPOTIFY_SCOPES was given but contained no scope names — unset it to use the default scopes, or list scopes explicitly.',
    );
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const s of parts) {
    if (seen.has(s)) continue;
    if (!isKnownScope(s)) {
      throw new Error(
        `Unknown scope in SPOTIFY_SCOPES: "${s}". Known scopes: ${[...KNOWN_SPOTIFY_SCOPES].sort().join(', ')}`,
      );
    }
    seen.add(s);
    deduped.push(s);
  }
  return deduped;
}

/**
 * Parse SPOTIFY_MCP_READONLY at config-load time: warns when the value names
 * no boolean, then defers to `readOnlyEnv` for the decision itself.
 *
 * The warning is the point. Without it a typo reads as "off" — the server
 * registers every write module and says nothing, which is the one outcome an
 * operator who set this flag is trying to rule out. The flag is a safety
 * switch, so a value we cannot interpret earns a line on stderr naming the
 * accepted spellings. It is NOT an error: refusing to start would take a
 * read-only host offline over a cosmetic mistake, and silently downgrading to
 * off — not saying so — is the actual failure mode.
 *
 * Only config load warns. The gate (`readOnlyModeEnabled`) is consulted at
 * registration and again on every write-capable call, so warning there would
 * repeat one line per request.
 */
export function parseReadOnly(raw: string | undefined): boolean {
  if (unrecognisedBooleanEnv(raw)) {
    console.error(
      `[spotify-mcp] SPOTIFY_MCP_READONLY "${raw?.trim()}" names no boolean; treating read-only mode as OFF. `
        + `Accepted: ${TRUTHY_ENV_VALUES.join(', ')}. `
        + 'If you meant to enable it, the value above is not one this server reads as true.',
    );
  }
  return readOnlyEnv({ SPOTIFY_MCP_READONLY: raw });
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
  const fanout = resolveFanoutConcurrency(env);
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
    fanoutConcurrency: fanout.limit,
    fanoutConcurrencySource: fanout.source,
    maxConcurrency: Math.min(
      positiveInt(env.SPOTIFY_MCP_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
      MAX_CONCURRENCY_CEILING,
    ),
    scopes,
    market: parseMarket(env.SPOTIFY_MCP_MARKET),
    readonly: parseReadOnly(env.SPOTIFY_MCP_READONLY),
  };
}

/**
 * Resolve the fan-out width and where it came from (#783).
 *
 * The source travels with the value because the radar payloads name it in
 * prose: reporting the default's name while a variable is actually in force is
 * the same small lie showradar's `resolveBudget` was written to avoid. An
 * unset, unparsable or non-positive value falls back, parsing exactly as
 * positiveInt does.
 *
 * ## Precedence: the funnel's knob wins (#892)
 *
 * `SPOTIFY_MCP_MAX_CONCURRENCY` is read FIRST, ahead of this tool's own
 * `SPOTIFY_MCP_FANOUT_CONCURRENCY`. That ordering is the whole point, and it
 * is not cosmetic:
 *
 *  - Both knobs bound the same quantity — requests in flight — from two
 *    different places. If each had its own independent default (4 here, 3
 *    there), the effective width would be whichever happened to be smaller,
 *    chosen by a comparison no operator can see and no payload can report.
 *    Setting the tool-side width to the funnel's own number means the two
 *    agree by construction, so the fan-out is never the reason a call is
 *    slower than the funnel allows.
 *  - The disclosure these values feed (`fanout_concurrency`) has to stay TRUE.
 *    A tool reporting `4` while the funnel permits `3` is describing a
 *    concurrency that never happened — AGENTS.md §6's "a correctly named
 *    payload field can still lie about its value", in the exact shape this
 *    change would otherwise have walked into.
 *
 * `SPOTIFY_MCP_FANOUT_CONCURRENCY` remains as the fallback for environments
 * where the funnel knob is not set, and is the only way to narrow a single
 * scan below the funnel width (to keep a bulk scan from taking every permit
 * an interactive read could use). Set it and `source` says so, so the payload
 * never reports the funnel's number for a width the operator actually chose.
 *
 * ## The funnel's value is RESOLVED here, not read raw (#892)
 *
 * Reading `SPOTIFY_MCP_MAX_CONCURRENCY` straight off the env — the shape this
 * had while #892 was still open — hands back a number the funnel never uses.
 * Two cases follow, and both are the "correctly named payload field can still
 * lie about its value" failure the precedence above exists to prevent:
 *
 *  - **Unset.** The funnel does not treat an unset knob as absent, it resolves
 *    it to `DEFAULT_MAX_CONCURRENCY` (3). Falling through to
 *    `DEFAULT_FANOUT_CONCURRENCY` (4) therefore reported a fan-out of 4 while
 *    the funnel permitted 3 — in the DEFAULT case, with nothing configured.
 *  - **Over the ceiling.** `SPOTIFY_MCP_MAX_CONCURRENCY=5000` is clamped to
 *    `MAX_CONCURRENCY_CEILING` (32) for the funnel; read raw it yielded 5000,
 *    so the payload named a width 156x larger than any request could reach.
 *
 * So the funnel's number is resolved through the same `positiveInt` + clamp
 * the funnel itself uses, and only an EXPLICIT operator choice of
 * `SPOTIFY_MCP_FANOUT_CONCURRENCY` may report itself as the source. The two
 * knobs now agree by construction in every case, which is what the precedence
 * section above was claiming all along.
 */
export function resolveFanoutConcurrency(
  env: NodeJS.ProcessEnv = process.env,
): { limit: number; source: string } {
  // Only an explicitly-set knob names itself as the source. An unset funnel
  // knob is not "the operator chose the funnel", and reporting the funnel's
  // name for a width nobody set is the same small lie as a wrong number.
  if (env.SPOTIFY_MCP_MAX_CONCURRENCY !== undefined && env.SPOTIFY_MCP_MAX_CONCURRENCY !== '') {
    return {
      limit: Math.min(
        positiveInt(env.SPOTIFY_MCP_MAX_CONCURRENCY, DEFAULT_MAX_CONCURRENCY),
        MAX_CONCURRENCY_CEILING,
      ),
      source: 'SPOTIFY_MCP_MAX_CONCURRENCY',
    };
  }
  const parsed = Number.parseInt(env.SPOTIFY_MCP_FANOUT_CONCURRENCY ?? '', 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return {
      limit: Math.min(parsed, MAX_CONCURRENCY_CEILING),
      source: 'SPOTIFY_MCP_FANOUT_CONCURRENCY',
    };
  }
  // Neither set: take the funnel's own resolved default rather than a second
  // default, so an unconfigured server has exactly ONE concurrency number.
  return { limit: DEFAULT_MAX_CONCURRENCY, source: 'default' };
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

/**
 * The variables `--help` and `.env.example` are generated from (#621).
 *
 * ## Why a registry rather than prose in two files
 *
 * `--help` listed five variables, `.env.example` listed six, and neither
 * mentioned the ones that change the token file, the consent prompt or the tool
 * surface — the three settings an operator most needs to find. The
 * copy-to-.env template presents itself as complete, so filling it in still ran
 * with the default profile, the full 17-scope grant, and no read-only notice,
 * with nothing in the output to say so. Users and agents discovered these only
 * by finding `docs/configuration.md`.
 *
 * A hand-written list in each file reproduces exactly that drift, so this is
 * one list with the description and default next to the name. `--help` renders
 * it, and `tests/docs.env-parity.test.ts` fails if `.env.example` or
 * `docs/configuration.md` stops naming one of these.
 *
 * ## What is deliberately NOT here
 *
 * This is the QUICK-REFERENCE set, not the complete env surface — the server
 * reads more than this (receipts, backup retention, sidecar paths, …), and
 * docs/configuration.md remains the full reference. The registry is what an
 * operator should be able to discover from `--help` alone: the variables that
 * change which account is used, what is consented to, or which tools exist.
 * Widening it to every variable would make `--help` a wall of tuning knobs and
 * stop being a quick reference.
 */
export interface DocumentedEnvVar {
  /** The variable name, exactly as the server reads it. */
  name: string;
  /** One-line purpose, written for someone configuring, not implementing. */
  summary: string;
  /** Shown in --help; `null` when there is no single default worth printing. */
  default: string | null;
  /** Whether --help mentions it. The full reference documents all of them. */
  inHelp: boolean;
}

export const DOCUMENTED_ENV_VARS: readonly DocumentedEnvVar[] = [
  {
    name: 'SPOTIFY_CLIENT_ID',
    summary: 'Required. OAuth Client ID of your Spotify app (developer.spotify.com dashboard).',
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_REDIRECT_URI',
    summary: 'OAuth redirect URI; must match the app dashboard exactly.',
    default: 'http://127.0.0.1:8888/callback',
    inHelp: true,
  },
  {
    name: 'SPOTIFY_HEADLESS',
    summary: `Browserless paste-flow auth (${TRUTHY_ENV_VALUES.join('/')}).`,
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_TOKEN_FILE',
    summary: 'Token file path. Wins over SPOTIFY_MCP_PROFILE.',
    default: '~/.spotify-mcp/tokens.json',
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_PROFILE',
    summary: 'Profile name; selects ~/.spotify-mcp/tokens.<profile>.json. The `auth --profile` equivalent.',
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_SCOPES',
    summary: `Space/comma-separated OAuth scopes to request instead of the ${DEFAULT_SCOPES.length} defaults. An unknown scope fails startup.`,
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_READONLY',
    summary: `Hide every write-capable module (${TRUTHY_ENV_VALUES.join('/')}). The hard read-only guarantee.`,
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_CONFIRM',
    summary: 'Set to exactly `never` to skip destructive-operation confirmation. Automation only.',
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_TOOLSETS',
    summary: 'Comma-separated toolsets to register (`all` or unset registers everything).',
    default: 'all',
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_MARKET',
    summary: 'Default ISO 3166-1 alpha-2 market for market-gated lookups.',
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_MAX_ITEMS',
    summary: 'Default per-call item cap for list tools; `max_results` overrides per call.',
    default: String(DEFAULT_MAX_ITEMS),
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_FETCH_ALL_CAP',
    summary: 'Hard cap for fetch_all=true pagination walks.',
    default: String(DEFAULT_FETCH_ALL_CAP),
    inHelp: true,
  },
  {
    name: 'SPOTIFY_MCP_HISTORY',
    summary: `Log one JSONL line per agent-driven mutation (${TRUTHY_ENV_VALUES.join('/')}).`,
    default: null,
    inHelp: true,
  },
  {
    name: 'SPOTIFY_REQUEST_TIMEOUT_MS',
    summary: 'Per-request timeout for Spotify API calls and token refresh.',
    default: String(DEFAULT_REQUEST_TIMEOUT_MS),
    inHelp: true,
  },
] as const;

/** Render the registry as the `Environment:` block of `--help`. */
export function renderEnvHelp(): string {
  const width = Math.max(...DOCUMENTED_ENV_VARS.filter((v) => v.inHelp).map((v) => v.name.length));
  return DOCUMENTED_ENV_VARS.filter((v) => v.inHelp)
    .map((v) => {
      const suffix = v.default ? ` (default ${v.default})` : '';
      return `  ${v.name.padEnd(width)}  ${v.summary}${suffix}`;
    })
    .join('\n');
}
