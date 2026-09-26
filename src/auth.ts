import { createHash, randomBytes } from 'crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { chmod, mkdir, open as openFile, readFile, rename, stat, unlink } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, dirname } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import open from 'open';
import type { TokenData } from './types/spotify.js';

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback';
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
const CALLBACK_PATH = REDIRECT_URL.pathname || '/';
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

/** Escape a value for safe interpolation into an HTML response body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_SCOPES_LIST: readonly string[] = [
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

const DEFAULT_SCOPES = DEFAULT_SCOPES_LIST.join(' ');

/** Known Spotify scope vocab — mirrors src/config.ts KNOWN_SPOTIFY_SCOPES. */
const KNOWN_SCOPES = new Set<string>([
  ...DEFAULT_SCOPES_LIST,
  'app-remote-control',
  'streaming',
]);

/**
 * Parse SPOTIFY_SCOPES / --scopes CLI flag: space- or comma-separated, validated,
 * de-duplicated. Returns null when not set.
 */
function parseScopesString(raw: string | undefined): string[] | null {
  if (!raw || raw.trim() === '') return null;
  const parts = raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const s of parts) {
    if (seen.has(s)) continue;
    if (!KNOWN_SCOPES.has(s)) {
      throw new Error(
        `Unknown scope "${s}". Known scopes: ${[...KNOWN_SCOPES].sort().join(', ')}`,
      );
    }
    seen.add(s);
    deduped.push(s);
  }
  if (deduped.length === 0) return null;
  return deduped;
}

/** Resolve scopes for the current auth flow: CLI --scopes > SPOTIFY_SCOPES env > default. */
function resolveScopes(cliScopes?: string): string {
  // CLI takes precedence
  if (cliScopes !== undefined) {
    const parsed = parseScopesString(cliScopes);
    if (parsed) return parsed.join(' ');
  }
  const envParsed = parseScopesString(process.env.SPOTIFY_SCOPES);
  if (envParsed) return envParsed.join(' ');
  return DEFAULT_SCOPES;
}

/** Parse --profile / --scopes from process.argv (auth subcommand). */
function parseAuthArgs(argv: string[] = process.argv.slice(2)): {
  profile?: string;
  scopes?: string;
} {
  const result: { profile?: string; scopes?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' && i + 1 < argv.length) {
      result.profile = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--profile=')) {
      result.profile = argv[i].slice('--profile='.length);
    } else if (argv[i] === '--scopes' && i + 1 < argv.length) {
      result.scopes = argv[i + 1];
      i++;
    } else if (argv[i].startsWith('--scopes=')) {
      result.scopes = argv[i].slice('--scopes='.length);
    }
  }
  return result;
}

function validateProfileName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid --profile "${trimmed}": must match [A-Za-z0-9._-]+`);
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error(`Invalid --profile "${trimmed}"`);
  }
  return trimmed;
}

/**
 * Resolve token file path. Precedence: SPOTIFY_MCP_TOKEN_FILE > --profile / SPOTIFY_MCP_PROFILE > default.
 * Exported as function for dynamic resolution (tests + multi-profile).
 */
function getTokenFile(cliProfile?: string): string {
  if (process.env.SPOTIFY_MCP_TOKEN_FILE) return process.env.SPOTIFY_MCP_TOKEN_FILE;
  const profile = cliProfile ?? process.env.SPOTIFY_MCP_PROFILE;
  if (profile) {
    const validated = validateProfileName(profile);
    return join(homedir(), '.spotify-mcp', `tokens.${validated}.json`);
  }
  return join(homedir(), '.spotify-mcp', 'tokens.json');
}

/**
 * Resolved token-file path. Override with SPOTIFY_MCP_TOKEN_FILE (e.g. to
 * point tests at a temp file); defaults to ~/.spotify-mcp/tokens.json.
 * For profile-aware resolution, use getTokenFile().
 */
export const TOKEN_FILE = getTokenFile();

function truthyEnv(raw: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((raw ?? '').trim().toLowerCase());
}

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

  const authArgs = parseAuthArgs();
  const effectiveScopes = (() => {
    try {
      return resolveScopes(authArgs.scopes);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })() as string;

  // Validate profile early so we fail fast
  if (authArgs.profile) {
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

  // Start local callback server
  const tokens = await new Promise<TokenData>((resolve, reject) => {
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

    const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('Method not allowed');
        return;
      }

      let url: URL;
      try {
        url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);
      } catch {
        res.writeHead(400);
        res.end('Bad request');
        return;
      }
      if (url.pathname !== CALLBACK_PATH) {
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
        reject(new Error(`Spotify auth error: ${error}`));
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
        resolve(result);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Internal error during token exchange.</h1>');
        closeServers();
        reject(err);
      }
    };

    const onListening = () => {
      if (browserOpened) return;
      browserOpened = true;
      console.log(`Waiting for callback at ${REDIRECT_URI}...`);
      console.log(`Opening Spotify authorization page...`);
      console.log(`If your browser doesn't open, visit:\n${authUrl}`);
      open(authUrl).catch(() => {
        console.log(`Could not open browser automatically. Visit:\n${authUrl}`);
      });
    };

    bindHosts.forEach((host, index) => {
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
        reject(new Error(`Failed to start callback server: ${err.message}`));
      });
      server.listen(CALLBACK_PORT, host, onListening);
    });
  });

  await saveTokens(tokens);
  const tf = getTokenFile(authArgs.profile);
  console.log(`Authentication successful! Tokens saved to ${tf}`);
}
