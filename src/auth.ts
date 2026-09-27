import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { chmod, mkdir, open as openFile, readFile, rename, stat, unlink } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, dirname } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import open from 'open';
import type { TokenData } from './types/spotify.js';
// The scope vocabulary and the boolean-env rule are owned by config.ts (#618,
// #611) so the auth flow, the config loader and the documentation cannot hold
// separate copies of either. Imported statically: config.ts imports nothing
// from this module, so there is no cycle.
import {
  DEFAULT_SCOPES as SCOPE_DEFAULTS,
  KNOWN_SPOTIFY_SCOPES,
  isKnownScope,
  truthyEnv,
} from './config.js';

/**
 * The default loopback redirect, exported so a failure message can name the
 * value the operator has to match in the Spotify Developer Dashboard instead of
 * restating it in prose (AGENTS.md §1: registered exactly, `127.0.0.1`, never
 * `localhost`).
 */
export const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8888/callback';

/**
 * Upper bound on how long the browser flow waits for the OAuth callback.
 *
 * Trade-off: the wait must be bounded, because an unbounded one holds the
 * callback port and turns every later run into a bare EADDRINUSE with no
 * diagnosis — but the bound has to clear the time a human needs to read the
 * auth URL, log in, click through the consent screen and wait for the
 * redirect, including a slow mobile login. 5 minutes is roughly 2-3x that;
 * materially below ~2 minutes starts failing people who are mid-approval, and
 * re-running is cheap precisely because the port is released on both the
 * success and the failure path. Override with SPOTIFY_AUTH_TIMEOUT_MS for CI
 * and for hosts where nobody will be standing by a browser (#614).
 */
export const DEFAULT_AUTH_CALLBACK_TIMEOUT_MS = 300_000;

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
// Derive bind port and route path from SPOTIFY_REDIRECT_URI so an overridden
// redirect URI (e.g. http://127.0.0.1:9000/callback) is honored end-to-end.
// Invalid values are reported by validateRedirectUri when auth starts rather
// than crashing module import for unrelated MCP commands.
let REDIRECT_URL: URL;
try {
  REDIRECT_URL = new URL(REDIRECT_URI);
} catch {
  REDIRECT_URL = new URL('http://127.0.0.1:8888/callback');
}
const CALLBACK_PORT = REDIRECT_URL.port
  ? Number(REDIRECT_URL.port)
  : REDIRECT_URL.protocol === 'https:'
    ? 443
    : 80;
const REDIRECT_EXPECTED = `${REDIRECT_URL.origin}${REDIRECT_URL.pathname}`;

/**
 * True when the host is a loopback address (localhost, 127.0.0.0/8 or ::1).
 * The OAuth spec requires loopback redirect URIs for native apps, and the
 * local callback server can only receive traffic on loopback.
 */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    host === 'localhost' ||
    host === '::1' ||
    host.startsWith('::ffff:127.') ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/** Validate the configured native-app redirect before starting the flow. */
export function validateRedirectUri(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(
      'SPOTIFY_REDIRECT_URI must be a valid loopback redirect URL (expected http://127.0.0.1/callback).',
    );
  }
  if (parsed.protocol !== 'http:') {
    throw new Error(
      'SPOTIFY_REDIRECT_URI must use http:// because the local callback listener is plain HTTP; loopback redirects only.',
    );
  }
  if (!isLoopbackHost(parsed.hostname)) {
    throw new Error(
      'SPOTIFY_REDIRECT_URI must point to a loopback host (localhost, 127.0.0.0/8 or ::1).',
    );
  }
  return parsed;
}

/** Return the port the plain-HTTP callback listener must bind for a URI. */
export function getCallbackPort(raw: string): number {
  const parsed = validateRedirectUri(raw);
  return parsed.port ? Number(parsed.port) : 80;
}

/**
 * Resolve the callback wait bound. A blank, non-numeric or non-positive value
 * falls back to the default rather than disabling the bound: an operator who
 * mistyped the knob should still get a bounded wait, because the unbounded case
 * is the one that has no diagnosis.
 */
export function resolveAuthCallbackTimeoutMs(
  raw: string | undefined = process.env.SPOTIFY_AUTH_TIMEOUT_MS,
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_AUTH_CALLBACK_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_AUTH_CALLBACK_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Render a millisecond bound for a human (`300000 ms (5m)`). */
function formatTimeout(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${ms} ms (${seconds}s)`;
  const minutes = seconds / 60;
  const rounded = Number.isInteger(minutes) ? minutes : Math.round(minutes * 10) / 10;
  return `${ms} ms (${rounded}m)`;
}

/**
 * The callback listener bound and nothing ever arrived. Deliberately a
 * different message from the port-busy one: here the port was free and is free
 * again, so pointing the operator at a port conflict would send them to the
 * wrong check. What is left is the redirect itself — an abandoned browser, or a
 * browser that never got as far as the callback (wrong registered URI, an
 * error page, a cancelled consent screen).
 */
export function authCallbackTimeoutMessage(
  timeoutMs: number,
  redirectUri: string,
  port: number,
): string {
  const host = new URL(redirectUri).hostname;
  return (
    `Timed out after ${formatTimeout(timeoutMs)} waiting for the browser callback at ${redirectUri} ` +
    `— no callback request arrived, and the listener on port ${port} has been closed. ` +
    `That port is free again, so this is not a port conflict.\n` +
    `The listener was up the whole time, so the redirect never reached it. Check that:\n` +
    `  - the browser finished the Spotify approval page and the tab was not closed before the redirect;\n` +
    `  - the browser did not stop on an error page instead (a captive portal, a TLS interception error, ` +
    `or a wrong client id shows one, and the callback is never requested);\n` +
    `  - ${redirectUri} is registered EXACTLY in the Spotify Developer Dashboard — host ${host}, ` +
    `not localhost, and the same port and path.\n` +
    `Then re-run spotify-mcp auth. To change the bound set SPOTIFY_AUTH_TIMEOUT_MS (currently ${timeoutMs}); ` +
    `with no browser available, use SPOTIFY_HEADLESS=1 and paste the redirect URL instead.`
  );
}

/**
 * A listener that could not bind at all. EADDRINUSE gets its own message
 * because it is the one start-up failure the operator can fix before retrying,
 * and it is exactly what a previous `spotify-mcp auth` leaves behind — either
 * one still running, or one that hung before this bound existed. The message
 * therefore names the port, the default redirect URI, and both ways out. Any
 * other listen error keeps the raw system text, which already names its cause.
 */
export function callbackListenError(err: unknown, port: number): Error {
  const detail = err instanceof Error ? err.message : String(err);
  if ((err as NodeJS.ErrnoException | null)?.code !== 'EADDRINUSE') {
    return new Error(`Failed to start callback server: ${detail}`);
  }
  return new Error(
    `Failed to start callback server: ${detail}\n` +
      `Port ${port} is already in use (EADDRINUSE), so no callback listener could bind. ` +
      `The usual owner is an earlier \`spotify-mcp auth\` still waiting for its browser redirect, ` +
      `or another program that holds the port. ` +
      `Find it with \`ss -lptn 'sport = :${port}'\` or \`lsof -i :${port}\`, and end it if it is a stale auth run.\n` +
      `To use another port, set SPOTIFY_REDIRECT_URI to a free loopback URI such as ` +
      `http://127.0.0.1:${port + 1}/callback and register that exact URI in the Spotify Developer Dashboard. ` +
      `The default is ${DEFAULT_REDIRECT_URI} — host 127.0.0.1, not localhost.`,
  );
}

/**
 * Timer seam for the callback wait. The real implementation holds one handle
 * and clears it on every settle; a test substitutes one whose expiry it can
 * fire synchronously, so the bound is provable without spending real seconds.
 */
export interface AuthTimer {
  set(fn: () => void, ms: number): void;
  clear(): void;
}

/** The real timer: one handle, armed before the wait and cleared on settle. */
function systemTimer(): AuthTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return {
    set(fn, ms) {
      handle = setTimeout(fn, ms);
    },
    clear() {
      if (handle !== undefined) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

/** Escape a value for safe interpolation into an HTML response body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Scope vocabulary and defaults come from config.ts (#618) — this module used
 * to hold a second hand-maintained copy of both, kept in step only by a
 * comment. A scope added to one side and not the other produced a startup
 * error that named this file, or a scope this flow requested and the server
 * then rejected, and the failure looked like a config bug rather than an edit.
 *
 * `DEFAULT_SCOPES` is the array; the auth flow needs the space-joined form the
 * token request carries.
 */
const DEFAULT_SCOPES = SCOPE_DEFAULTS.join(' ');

/**
 * Parse SPOTIFY_SCOPES / --scopes: space- or comma-separated, validated,
 * de-duplicated. Returns null **only** when the value is absent (undefined).
 *
 * A value that is present but names no scope is an error, not "unset" (#617).
 * Conflating the two made `--scopes=` and `SPOTIFY_SCOPES=" "` fall through to
 * the 17-scope default — the widest consent set, five mutation scopes
 * included, the exact opposite of the narrow request the operator made, and the
 * opposite of the minimum-scope rule in AGENTS.md §1.
 */
export function parseScopesString(
  raw: string | undefined,
  label = '--scopes',
): string[] | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(
      `${label} was given but contained no scope names — pass at least one scope, or unset it to use the defaults.`,
    );
  }
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const s of parts) {
    if (seen.has(s)) continue;
    if (!isKnownScope(s)) {
      throw new Error(
        `Unknown scope "${s}". Known scopes: ${[...KNOWN_SPOTIFY_SCOPES].sort().join(', ')}`,
      );
    }
    seen.add(s);
    deduped.push(s);
  }
  return deduped;
}

/**
 * Resolve scopes for the current auth flow: CLI --scopes > SPOTIFY_SCOPES env > default.
 * The env argument is injectable so the precedence is testable without mutating
 * process.env; only a genuine absence (undefined) falls through to the default.
 */
export function resolveScopes(
  cliScopes?: string,
  envScopes: string | undefined = process.env.SPOTIFY_SCOPES,
): string {
  // CLI takes precedence
  const cli = parseScopesString(cliScopes, '--scopes');
  if (cli) return cli.join(' ');
  const env = parseScopesString(envScopes, 'SPOTIFY_SCOPES');
  if (env) return env.join(' ');
  return DEFAULT_SCOPES;
}

/** Profile names become file names, so they are restricted to a safe charset. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const EMPTY_PROFILE_ERROR = '--profile requires a name matching [A-Za-z0-9._-]+';
const EMPTY_SCOPES_ERROR = '--scopes was given but contained no scope names';

/**
 * Parse --profile / --scopes from argv (auth subcommand).
 *
 * A flag that is present but carries no value is an error (#617), not a
 * fall-through to the default. `--profile ""` and a dangling trailing
 * `--profile` used to be indistinguishable from "no profile at all", so
 * `auth --profile "$UNSET_VAR"` wrote tokens into the shared default file
 * while the operator believed a named profile had been created. An empty
 * `--scopes` used to be read as "unset" and widened the request to every
 * default scope.
 */
export function parseAuthArgs(argv: string[] = process.argv.slice(2)): {
  profile?: string;
  scopes?: string;
} {
  const result: { profile?: string; scopes?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--profile') {
      if (i + 1 >= argv.length || argv[i + 1].trim() === '') {
        throw new Error(EMPTY_PROFILE_ERROR);
      }
      result.profile = argv[i + 1];
      i++;
    } else if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length);
      if (value.trim() === '') throw new Error(EMPTY_PROFILE_ERROR);
      result.profile = value;
    } else if (arg === '--scopes') {
      if (i + 1 >= argv.length || argv[i + 1].trim() === '') {
        throw new Error(EMPTY_SCOPES_ERROR);
      }
      result.scopes = argv[i + 1];
      i++;
    } else if (arg.startsWith('--scopes=')) {
      const value = arg.slice('--scopes='.length);
      if (value.trim() === '') throw new Error(EMPTY_SCOPES_ERROR);
      result.scopes = value;
    }
  }
  return result;
}

function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!PROFILE_NAME_PATTERN.test(trimmed)) {
    throw new Error(`Invalid --profile "${trimmed}": must match [A-Za-z0-9._-]+`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`Invalid --profile "${trimmed}"`);
  }
  return trimmed;
}

/**
 * The active profile name, validated, or undefined for the default account.
 *
 * Exported so every per-profile artefact resolves it through ONE function.
 * A second, near-identical profile-resolution implementation is how the
 * persisted cache came to ignore `--profile` entirely while the token file
 * honoured it (#1249 review): the cache is then a single file shared by every
 * account on the box, which serves one account's reads to another.
 *
 * A cliProfile of '' is impossible from parseAuthArgs (#617 rejects it), and
 * the `if (profile)` guard is what makes an empty value mean "no profile" —
 * so the emptiness check lives in the argv parser, not here.
 */
export function activeProfile(cliProfile?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const profile = cliProfile ?? env.SPOTIFY_MCP_PROFILE;
  if (!profile) return undefined;
  return validateProfileName(profile);
}

/**
 * Resolve token file path. Precedence: SPOTIFY_MCP_TOKEN_FILE > --profile / SPOTIFY_MCP_PROFILE > default.
 * Exported as function for dynamic resolution (tests + multi-profile).
 *
 * A cliProfile of '' is impossible from parseAuthArgs (#617 rejects it), and the
 * `if (profile)` guard below is what makes an empty value mean "no profile" —
 * so the emptiness check lives in the argv parser, not here.
 */
export function getTokenFile(cliProfile?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.SPOTIFY_MCP_TOKEN_FILE) return env.SPOTIFY_MCP_TOKEN_FILE;
  const profile = activeProfile(cliProfile, env);
  if (profile) {
    return join(homedir(), '.spotify-mcp', `tokens.${profile}.json`);
  }
  return join(homedir(), '.spotify-mcp', 'tokens.json');
}

/**
 * Resolved token-file path. Override with SPOTIFY_MCP_TOKEN_FILE (e.g. to
 * point tests at a temp file); defaults to ~/.spotify-mcp/tokens.json.
 * For profile-aware resolution, use getTokenFile().
 */
export const TOKEN_FILE = getTokenFile();

/**
 * Returns true when SPOTIFY_HEADLESS is truthy, indicating the auth flow
 * should skip the local HTTP callback server and the `open()` browser step,
 * and instead prompt the operator to paste the redirect URL.
 *
 * Exported for testability (the env-var check is the gate for the whole
 * paste-URL flow).
 */
export function isHeadlessMode(): boolean {
  return truthyEnv(process.env.SPOTIFY_HEADLESS);
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

export function isTokenData(value: unknown): value is TokenData {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.access_token === 'string' &&
    candidate.access_token.trim() !== '' &&
    typeof candidate.refresh_token === 'string' &&
    candidate.refresh_token.trim() !== '' &&
    typeof candidate.expires_at === 'number' &&
    Number.isFinite(candidate.expires_at) &&
    (candidate.scope === undefined || typeof candidate.scope === 'string')
  );
}

function corruptedTokensError(tokenFile: string): Error {
  return new Error(
    `Saved Spotify tokens are corrupted at ${tokenFile} — run \`npm run auth\` again.`,
  );
}

export async function loadTokens(): Promise<TokenData> {
  const tokenFile = getTokenFile(parseAuthArgs().profile);
  try {
    const data = JSON.parse(await readFile(tokenFile, 'utf8')) as unknown;
    if (!isTokenData(data)) throw corruptedTokensError(tokenFile);
    return data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const profileHint = parseAuthArgs().profile ? ` (profile: ${parseAuthArgs().profile})` : (process.env.SPOTIFY_MCP_PROFILE ? ` (profile: ${process.env.SPOTIFY_MCP_PROFILE})` : '');
      throw new Error(`Not authenticated — no token file at ${tokenFile}${profileHint}. Run "spotify-mcp auth" (or "npm run auth") first.`);
    }
    if (err instanceof SyntaxError || (err instanceof Error && err.message.startsWith('Saved Spotify tokens are corrupted'))) {
      throw corruptedTokensError(tokenFile);
    }
    throw err;
  }
}

const tightenedTokenDirectories = new Set<string>();

/**
 * Persist tokens atomically (#109/#615): use a fresh exclusive sidecar,
 * owner-only directory/file modes, and normalize the final inode after rename.
 * Mode bits are ignored on Windows, matching the platform's existing behavior.
 */
export async function saveTokens(tokens: TokenData): Promise<void> {
  const tokenFile = getTokenFile(parseAuthArgs().profile);
  const tokenDirectory = dirname(tokenFile);
  await mkdir(tokenDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const directoryStat = await stat(tokenDirectory);
    if ((directoryStat.mode & 0o777) !== 0o700) {
      await chmod(tokenDirectory, 0o700);
      if (!tightenedTokenDirectories.has(tokenDirectory)) {
        console.warn(`Tightened token directory permissions to 0700: ${tokenDirectory}`);
      }
    }
    tightenedTokenDirectories.add(tokenDirectory);
  }

  // Remove the old fixed sidecar, if any, without following a pre-existing
  // symlink. New writes always use a unique, exclusively-created sidecar.
  const legacyTmpFile = `${tokenFile}.tmp`;
  await unlink(legacyTmpFile).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  const tmpFile = join(
    tokenDirectory,
    `.${basename(tokenFile, '.json')}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let created = false;
  try {
    const handle = await openFile(tmpFile, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(JSON.stringify(tokens, null, 2), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpFile, tokenFile);
    if (process.platform !== 'win32') await chmod(tokenFile, 0o600);
  } finally {
    if (created) {
      await unlink(tmpFile).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  }
}

/**
 * Exchange an authorization code (plus PKCE verifier) for tokens.
 * Used by both the browser flow (callback server extracts the code) and the
 * headless flow (operator pastes the redirect URL).
 */
async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  clientId: string,
): Promise<TokenData> {
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  // Use AbortSignal.timeout so a stalled network doesn't hang auth forever (#232).
  // Dynamically import getConfig to avoid circular deps at load time.
  let timeoutMs = 30_000;
  try {
    const { getConfig: gc } = await import('./config.js');
    timeoutMs = gc().spotifyRequestTimeoutMs;
  } catch {
    // fallback to default if config not yet initialized
  }
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
  }
  const data = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    scope?: string;
  };
  // Fall back to what we requested so downstream scope-aware gating always has something.
  const fallbackScopes = resolveScopes(parseAuthArgs().scopes);
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? fallbackScopes,
  };
}

/**
 * Headless auth flow for MCP servers running without a browser.
 */
async function runHeadlessAuthFlow(
  authUrl: string,
  codeVerifier: string,
  state: string,
  clientId: string,
): Promise<TokenData> {
  console.log('Headless auth mode (SPOTIFY_HEADLESS=1) — no browser will be opened.');
  console.log('');
  console.log('1. Visit this URL in any browser:');
  console.log(`   ${authUrl}`);
  console.log('');
  console.log('2. After approving, your browser will redirect to a URL starting with:');
  console.log(`   ${REDIRECT_URI}?code=***&state=...`);
  console.log('');
  console.log('3. Paste the full redirect URL here:');

  const rl = createInterface({ input, output });
  let pasted: string;
  try {
    pasted = (await rl.question('Redirect URL: ')).trim();
  } finally {
    rl.close();
  }
  if (!pasted) {
    throw new Error('No redirect URL pasted — auth aborted.');
  }

  const { code } = parseCallbackUrl(pasted, state);
  return exchangeCodeForTokens(code, codeVerifier, clientId);
}

/**
 * Parse and validate a pasted redirect URL from the headless auth flow.
 * State is checked before any provider error or authorization code handling.
 */
export function parseCallbackUrl(
  pasted: string,
  expectedState: string,
): { code: string } {
  let parsed: URL;
  try {
    parsed = new URL(pasted);
  } catch {
    throw new Error(
      `Pasted value is not a valid URL (expected a redirect URL starting with ${REDIRECT_EXPECTED}).`,
    );
  }

  const returnedState = parsed.searchParams.get('state');
  if (returnedState !== expectedState) {
    throw new Error(
      `State mismatch — pasted URL state does not match the issued state. ` +
        `Possible CSRF or wrong browser session.`,
    );
  }

  const errorParam = parsed.searchParams.get('error');
  if (errorParam) {
    throw new Error(`Spotify auth error from pasted URL: ${errorParam}`);
  }

  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new Error('No authorization code in pasted URL.');
  }

  return { code };
}

/** Inputs for one loopback callback wait. */
export interface CallbackWaitOptions {
  /** `state` issued in the authorization URL; a mismatch is refused. */
  readonly state: string;
  readonly codeVerifier: string;
  readonly clientId: string;
  /** The full redirect URI, used in failure messages only. */
  readonly redirectUri: string;
  /** Loopback hosts to bind. Never a wildcard. */
  readonly hosts: readonly string[];
  /** Port to bind on every host. */
  readonly port: number;
  /** Bound on the wait; see DEFAULT_AUTH_CALLBACK_TIMEOUT_MS. */
  readonly timeoutMs: number;
  /** Called once, when the first listener is up. */
  readonly onListening?: () => void;
  /** Timer seam; defaults to the real one. */
  readonly timer?: AuthTimer;
}

/**
 * Serve the OAuth callback until the browser redirect arrives, the redirect
 * reports an error, the listener cannot bind, or the wait expires (#614).
 *
 * The wait used to settle only on an incoming request, so an abandoned flow
 * held its port forever and the next attempt died on a bare EADDRINUSE that
 * said nothing about the previous run. The bound is armed before the first
 * `listen` and cleared on every settle, so a successful login never leaves a
 * timer holding the process open.
 *
 * Extracted from `runAuthFlow` and parameterized (host, port, timer) so the
 * expiry and the port-conflict paths are provable in a test: a fake timer fires
 * synchronously, and the listener binds an OS-assigned loopback port rather
 * than 8888.
 */
export function waitForCallback(options: CallbackWaitOptions): Promise<TokenData> {
  const { state, codeVerifier, clientId, redirectUri, hosts, port, timeoutMs, onListening } = options;
  const clock = options.timer ?? systemTimer();

  return new Promise<TokenData>((resolve, reject) => {
    const servers: ReturnType<typeof createServer>[] = [];
    let settled = false;
    let browserOpened = false;

    const closeServers = (): void => {
      for (const server of servers) {
        try {
          server.close();
        } catch {
          // A listener that failed during startup has no active handle.
        }
      }
    };

    /**
     * Settle exactly once. The bound is cleared here rather than only on the
     * timeout branch: a login that succeeded while a 5-minute timer was still
     * armed would keep the CLI alive long after it printed its result.
     */
    const finish = (settle: () => void): void => {
      clock.clear();
      settle();
    };

    // Armed before the first listen so a bind that never completes is covered
    // too, and so the two failure modes stay distinguishable: this timer only
    // wins the race when the listener came up and nothing ever called it.
    clock.set(() => {
      if (settled) return;
      settled = true;
      closeServers();
      finish(() => reject(new Error(authCallbackTimeoutMessage(timeoutMs, redirectUri, port))));
    }, timeoutMs);

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method not allowed');
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      const callbackPath = new URL(redirectUri).pathname || '/';
      if (url.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      // State is checked before error/code parameters. A forged request must
      // not be able to terminate an in-flight authorization flow.
      const returnedState = url.searchParams.get('state');
      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch — possible CSRF. Try again.</h1>');
        return;
      }
      if (settled) {
        res.writeHead(409, { 'Content-Type': 'text/html' });
        res.end('<h1>This authentication request was already handled.</h1>');
        return;
      }

      const error = url.searchParams.get('error');
      if (error) {
        settled = true;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication failed: ${escapeHtml(error)}</h1>`);
        closeServers();
        finish(() => reject(new Error(`Spotify auth error: ${error}`)));
        return;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>No authorization code received.</h1>');
        return;
      }

      // Claim the callback before the async exchange so a replay cannot
      // perform a second token exchange while the first one is in flight.
      settled = true;
      try {
        const result = await exchangeCodeForTokens(code, codeVerifier, clientId);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication successful. You can close this tab.</h1>');
        closeServers();
        finish(() => resolve(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Internal error during token exchange.</h1>');
        closeServers();
        finish(() => reject(err));
      }
    };

    hosts.forEach((host, index) => {
      const server = createServer(handler);
      servers.push(server);
      server.on('error', (err) => {
        if (index > 0) {
          // IPv6 is an optional companion for localhost; IPv4 remains the
          // required loopback listener and keeps the flow usable on IPv4-only hosts.
          console.warn(`IPv6 callback listener unavailable on ${host}: ${err.message}`);
          return;
        }
        if (settled) return;
        settled = true;
        closeServers();
        finish(() => reject(callbackListenError(err, port)));
      });
      server.listen(port, host, () => {
        if (browserOpened) return;
        browserOpened = true;
        onListening?.();
      });
    });
  });
}

export async function runAuthFlow(): Promise<void> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    console.error('Error: SPOTIFY_CLIENT_ID environment variable is not set.');
    process.exit(1);
  }
  try {
    validateRedirectUri(REDIRECT_URI);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // argv is validated before anything else can succeed: an empty or dangling
  // --profile / --scopes must fail here, not be read as "not set" (#617).
  const authArgs = (() => {
    try {
      return parseAuthArgs();
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })() as { profile?: string; scopes?: string };
  const effectiveScopes = (() => {
    try {
      return resolveScopes(authArgs.scopes);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })() as string;

  // Validate profile early so we fail fast. `!== undefined` rather than a
  // truthiness test: an empty name must be rejected, not skipped (#617).
  if (authArgs.profile !== undefined) {
    try {
      validateProfileName(authArgs.profile);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  }

  // Generate PKCE values
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash('sha256').update(codeVerifier).digest()
  );
  const state = base64url(randomBytes(16));

  // Build authorization URL
  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: effectiveScopes,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });
  const authUrl = `https://accounts.spotify.com/authorize?${authParams}`;

  // Headless mode: skip the local callback server and `open()` step.
  if (isHeadlessMode()) {
    const tokens = await runHeadlessAuthFlow(authUrl, codeVerifier, state, clientId);
    await saveTokens(tokens);
    const tf = getTokenFile(authArgs.profile);
    console.log(`Authentication successful! Tokens saved to ${tf}`);
    return;
  }

  // Bind explicitly to loopback interfaces. A localhost redirect gets both
  // loopback families for IPv4/IPv6 browser compatibility; neither is a
  // wildcard bind.
  const isLocalhostRedirect = REDIRECT_URL.hostname.toLowerCase() === 'localhost';
  const bindHosts = isLocalhostRedirect
    ? ['127.0.0.1', '::1']
    : [REDIRECT_URL.hostname.replace(/^\[|\]$/g, '')];

  // Start local callback server and wait — bounded, see #614.
  const tokens = await waitForCallback({
    state,
    codeVerifier,
    clientId,
    redirectUri: REDIRECT_URI,
    hosts: bindHosts,
    port: CALLBACK_PORT,
    timeoutMs: resolveAuthCallbackTimeoutMs(),
    onListening: () => {
      console.log(`Waiting for callback at ${REDIRECT_URI}...`);
      console.log(`Opening Spotify authorization page...`);
      console.log(`If your browser doesn't open, visit:\n${authUrl}`);
      open(authUrl).catch(() => {
        console.log(`Could not open browser automatically. Visit:\n${authUrl}`);
      });
    },
  });

  await saveTokens(tokens);
  const tf = getTokenFile(authArgs.profile);
  console.log(`Authentication successful! Tokens saved to ${tf}`);
}
