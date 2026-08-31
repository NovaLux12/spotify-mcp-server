import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { mkdir, writeFile, readFile, rename } from 'fs/promises';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import open from 'open';
import type { TokenData } from './types/spotify.js';

const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? 'http://127.0.0.1:8888/callback';
// Derive bind port and route path from SPOTIFY_REDIRECT_URI so an overridden
// redirect URI (e.g. http://127.0.0.1:9000/callback) is honored end-to-end.
const REDIRECT_URL = new URL(REDIRECT_URI);
const CALLBACK_PORT = Number(REDIRECT_URL.port) || 8888;
const CALLBACK_PATH = REDIRECT_URL.pathname;

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

/** Escape a value for safe interpolation into an HTML response body. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const DEFAULT_SCOPES_LIST: readonly string[] = [
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
export function parseScopesString(raw: string | undefined): string[] | null {
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
export function resolveScopes(cliScopes?: string): string {
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
export function parseAuthArgs(argv: string[] = process.argv.slice(2)): {
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
export function getTokenFile(cliProfile?: string): string {
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

export async function loadTokens(): Promise<TokenData> {
  const tokenFile = getTokenFile(parseAuthArgs().profile);
  try {
    const data = await readFile(tokenFile, 'utf8');
    return JSON.parse(data) as TokenData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const profileHint = parseAuthArgs().profile ? ` (profile: ${parseAuthArgs().profile})` : (process.env.SPOTIFY_MCP_PROFILE ? ` (profile: ${process.env.SPOTIFY_MCP_PROFILE})` : '');
      throw new Error(`Not authenticated — no token file at ${tokenFile}${profileHint}. Run "spotify-mcp auth" (or "npm run auth") first.`);
    }
    if (err instanceof SyntaxError) {
      throw new Error('Saved Spotify tokens are corrupted — run `npm run auth` again.');
    }
    throw err;
  }
}

/**
 * Persist tokens atomically (#109): write to a temp sibling with owner-only
 * mode, then rename over the target so a crash mid-write can never leave a
 * truncated or half-written tokens.json behind.
 */
export async function saveTokens(tokens: TokenData): Promise<void> {
  const tokenFile = getTokenFile(parseAuthArgs().profile);
  await mkdir(dirname(tokenFile), { recursive: true });
  const tmpFile = `${tokenFile}.tmp`;
  // Restrict to owner read/write only on creation (mode ignored on Windows).
  await writeFile(tmpFile, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  // rename replaces the destination atomically on POSIX; Node maps this to
  // MoveFileEx(REPLACE_EXISTING) on Windows.
  await rename(tmpFile, tokenFile);
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
 */
export function parseCallbackUrl(
  pasted: string,
  expectedState: string,
): { code: string } {
  let parsed: URL;
  try {
    parsed = new URL(pasted);
  } catch {
    throw new Error(`Pasted value is not a valid URL: ${pasted.slice(0, 80)}...`);
  }

  const errorParam = parsed.searchParams.get('error');
  if (errorParam) {
    throw new Error(`Spotify auth error from pasted URL: ${errorParam}`);
  }

  const returnedState = parsed.searchParams.get('state');
  if (returnedState !== expectedState) {
    throw new Error(
      `State mismatch — pasted URL state does not match the issued state. ` +
        `Possible CSRF or wrong browser session.`,
    );
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
  if (!isLoopbackHost(REDIRECT_URL.hostname)) {
    console.error(
      `Error: SPOTIFY_REDIRECT_URI (${REDIRECT_URI}) must point to a loopback host ` +
        '(localhost, 127.0.0.0/8 or ::1); the local callback server cannot receive ' +
        'redirects for any other host.'
    );
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

  // Determine server bind host: if redirect is localhost, bind dual-stack (no host arg) so both ::1 and 127.0.0.1 work.
  // Otherwise bind to the explicit loopback host logic.
  const isLocalhostRedirect = REDIRECT_URL.hostname.toLowerCase() === 'localhost';

  // Start local callback server
  const tokens = await new Promise<TokenData>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${CALLBACK_PORT}`);

      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const returnedState = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<h1>Authentication failed: ${escapeHtml(error)}</h1>`);
        server.close();
        reject(new Error(`Spotify auth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>State mismatch — possible CSRF. Try again.</h1>');
        server.close();
        reject(new Error('State mismatch in OAuth callback'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>No authorization code received.</h1>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      // Exchange code for tokens
      try {
        const result = await exchangeCodeForTokens(code, codeVerifier, clientId);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authentication successful. You can close this tab.</h1>');
        server.close();
        resolve(result);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h1>Internal error during token exchange.</h1>');
        server.close();
        reject(err);
      }
    });

    const onListening = () => {
      console.log(`Opening Spotify authorization page...`);
      console.log(`If your browser doesn't open, visit:\n${authUrl}`);
      open(authUrl).catch(() => {
        console.log(`Could not open browser automatically. Visit:\n${authUrl}`);
      });
    };

    if (isLocalhostRedirect) {
      // Dual-stack: no host arg lets Node bind to :: (both IPv4 and IPv6) when available.
      server.listen(CALLBACK_PORT, onListening);
    } else {
      server.listen(CALLBACK_PORT, '127.0.0.1', onListening);
    }

    server.on('error', (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });
  });

  await saveTokens(tokens);
  const tf = getTokenFile(authArgs.profile);
  console.log(`Authentication successful! Tokens saved to ${tf}`);
}
