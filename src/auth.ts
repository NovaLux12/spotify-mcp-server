import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';
import { mkdir, writeFile, readFile, chmod } from 'fs/promises';
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

const SCOPES = [
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
].join(' ');

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Resolved token-file path. Override with SPOTIFY_MCP_TOKEN_FILE (e.g. to
 * point tests at a temp file); defaults to ~/.spotify-mcp/tokens.json.
 */
export const TOKEN_FILE =
  process.env.SPOTIFY_MCP_TOKEN_FILE ?? join(homedir(), '.spotify-mcp', 'tokens.json');

/**
 * Returns true when SPOTIFY_HEADLESS=1 is set, indicating the auth flow
 * should skip the local HTTP callback server and the `open()` browser step,
 * and instead prompt the operator to paste the redirect URL.
 *
 * Exported for testability (the env-var check is the gate for the whole
 * paste-URL flow).
 */
export function isHeadlessMode(): boolean {
  return process.env.SPOTIFY_HEADLESS === '1';
}

export async function loadTokens(): Promise<TokenData> {
  try {
    const data = await readFile(TOKEN_FILE, 'utf8');
    return JSON.parse(data) as TokenData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Not authenticated. Run "spotify-mcp auth" (or "npm run auth") first.');
    }
    throw err;
  }
}

export async function saveTokens(tokens: TokenData): Promise<void> {
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  // Restrict to owner read/write only on creation (mode ignored on Windows)
  await writeFile(TOKEN_FILE, JSON.stringify(tokens, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(TOKEN_FILE, 0o600);
  } catch {
    // chmod may fail on Windows — that's acceptable; also tightens pre-existing files
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
  const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} ${text}`);
  }
  const data = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Headless auth flow for MCP servers running without a browser.
 *
 * Set SPOTIFY_HEADLESS=1 to skip the local callback server and `open()` step.
 * The auth URL is printed, the operator completes the flow in any browser,
 * then pastes the redirect URL back. The code + state are extracted and
 * exchanged server-side. Works across machines — useful when the MCP server
 * is remote (e.g. on a homelab) and the user is on a laptop.
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
  console.log(`   ${REDIRECT_URI}?code=...&state=...`);
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
 * Pure function — exported for unit testing.
 *
 * Throws on:
 *   - malformed URL
 *   - `error` query param (Spotify returned an OAuth error)
 *   - `state` mismatch (CSRF protection)
 *   - missing `code` query param
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
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });
  const authUrl = `https://accounts.spotify.com/authorize?${authParams}`;

  // Headless mode: skip the local callback server and `open()` step.
  // Useful for MCP servers running without a browser (remote hosts, CI,
  // homelabs, agent runtimes). The operator pastes the redirect URL back.
  if (isHeadlessMode()) {
    const tokens = await runHeadlessAuthFlow(authUrl, codeVerifier, state, clientId);
    await saveTokens(tokens);
    console.log('Authentication successful! Tokens saved to ~/.spotify-mcp/tokens.json');
    return;
  }

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

    server.listen(CALLBACK_PORT, '127.0.0.1', () => {
      console.log(`Opening Spotify authorization page...`);
      console.log(`If your browser doesn't open, visit:\n${authUrl}`);
      open(authUrl).catch(() => {
        console.log(`Could not open browser automatically. Visit:\n${authUrl}`);
      });
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });
  });

  await saveTokens(tokens);
  console.log('Authentication successful! Tokens saved to ~/.spotify-mcp/tokens.json');
}
