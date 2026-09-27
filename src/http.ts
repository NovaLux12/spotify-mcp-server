/**
 * The opt-in Streamable HTTP transport (#599).
 *
 * ## Why this is a separate module, and why it is imported dynamically
 *
 * `src/index.ts` imports this with `await import('./http.js')` and only on the
 * branch where `SPOTIFY_MCP_TRANSPORT=http`. That mirrors the lazy tool-module
 * loading in #906: a stdio host — which is every current host, and the one
 * OpenClaw runs — must not pay for evaluating a transport, a `node:http`
 * server, and `@hono/node-server` (pulled in by the SDK transport) that it
 * will never listen on.
 *
 * ## The trust boundary moved, and that is the whole difficulty
 *
 * Over stdio the transport IS the trust boundary: whoever can spawn the process
 * already has the user's privileges, so the process needs no credential of its
 * own. A socket removes that property. Anything that can open a TCP connection
 * to this port can, without a credential, enumerate the entire registered tool
 * surface and every schema in it — and those schemas describe destructive
 * writes against a real Spotify account, which is a disclosure about the
 * account before any call is made. (The size of that surface is measured by
 * `npm run count:tools`; it is deliberately not written down here.)
 *
 * So the rules here are, in order of how much they matter:
 *
 *  1. **Off by default.** `resolveHttpConfig` returns `enabled: false` for
 *     anything that is not an explicit `http`, and returns it WITHOUT reading
 *     any other `SPOTIFY_MCP_HTTP_*` variable. An opt-in that also changed the
 *     default path would not be opt-in.
 *  2. **Authenticated before anything.** The bearer check runs before the
 *     method is dispatched and before a session is built, so an unauthenticated
 *     request cannot reach `initialize`, `tools/list`, or even a registry. See
 *     `authorize`.
 *  3. **Loopback unless the operator says otherwise.** Binding `0.0.0.0`
 *     requires `SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK` as a SECOND, separate
 *     act of configuration. A typo cannot publish this server to a network.
 *  4. **Fail closed on the credential itself.** There is no default token, no
 *     anonymous mode, and no way to start the listener without one. This is the
 *     same posture as `requiredConfirmationRefusal()` (#585), which treats an
 *     `unsupported` verdict and a mid-flight prompt failure both as refusals.
 *  5. **The token never appears in output.** Not in the startup banner, not in
 *     an error, not in a log line, and — because the credential for Spotify
 *     itself lives in the token file this server reads — never in a response
 *     body either. `tests/http.security.test.ts` asserts the token is absent
 *     from the child's entire stdout and stderr.
 *
 * ## Why a static bearer token, and not OAuth
 *
 * A resource-server OAuth design (the thing #599 step 3 gestures at for hosted
 * deployments) is a different feature: it needs an authorization server, a
 * token endpoint, per-caller identity, and a decision about how a remote
 * process completes a Spotify login at all — the loopback redirect check in
 * `src/auth.ts` refuses anything else. None of that is shippable inside one
 * change, and shipping a half of it is how a server ends up with a token
 * endpoint that nobody threat-models.
 *
 * A pre-provisioned shared secret is the smallest thing that makes the socket
 * non-world-readable, and it is honest about what it is: ONE user, ONE
 * process, ONE account, ONE token. The bearer token is a network credential
 * guarding a network transport; it is NOT a Spotify credential and grants no
 * Spotify scope of its own. Multi-user hosting stays an explicit non-goal
 * (`docs/non-goals.md`).
 *
 * ## Sessions are isolated, and the cost of that is stated
 *
 * The MCP SDK's `Server` can hold exactly one transport, so a multi-session
 * server needs one `McpServer` per session — which means one full tool
 * registration per session. That is why `maxSessions` defaults to 8: each
 * session holds a live registry, and the aggregate surface is ~600 KB of JSON
 * before the SDK's object overhead. The cap is a memory bound, and exceeding it
 * is a 503, never a silent eviction of a live session.
 *
 * Each session also gets its own `SpotifyClient`, deliberately. A shared client
 * would be better for token-refresh contention, but `setProgressReporter` is a
 * single slot on the client (`src/progress.ts`), so a second session's
 * registration would redirect the FIRST session's progress notifications onto
 * the second session's SSE stream. That is cross-session leakage, it happens
 * every time a second client connects, and the same-token contention it avoids
 * is already covered by the cross-process refresh guard in `src/client.ts`.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { truthyEnv } from './config.js';

/** Transport name for the default, unchanged stdio path. */
const TRANSPORT_STDIO = 'stdio';
/** Transport name selecting this module. */
const TRANSPORT_HTTP = 'http';

/**
 * Default listener port.
 *
 * Deliberately NOT 8888. That is the OAuth callback redirect's port
 * (`SPOTIFY_REDIRECT_URI`, defaulted in `src/config.ts`), and running `auth` and
 * an HTTP server at the same time is an ordinary thing for one user to do.
 */
export const DEFAULT_HTTP_PORT = 9871;

/** Loopback by default; anything else needs the separate non-loopback opt-in. */
export const DEFAULT_HTTP_BIND = '127.0.0.1';

/** The MCP endpoint path. Everything that is not this path is a 404. */
export const DEFAULT_HTTP_PATH = '/mcp';

/**
 * Default request-body ceiling (1 MiB).
 *
 * The largest legitimate MCP request here is a `tools/call` with a wide
 * `include_items`; the measured worst case is far below this. A network
 * endpoint with no body cap is a memory-exhaustion vector, and the transport
 * itself buffers the body, so the cap has to live here rather than in a
 * middleware the SDK owns.
 */
export const DEFAULT_HTTP_MAX_BODY_BYTES = 1_048_576;

/** Default request budget per client address, per minute. */
export const DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE = 600;

/**
 * Default live-session cap.
 *
 * Eight is a memory bound, not a throughput claim: each session holds its own
 * tool registry, and the aggregate surface is ~600 KB of JSON before the SDK's
 * object overhead. A single-user deployment has one host and maybe a browser
 * client; a number high enough to be a DoS surface is not a feature.
 */
export const DEFAULT_HTTP_MAX_SESSIONS = 8;

/**
 * Shortest accepted bearer token.
 *
 * A shared secret that a human types has to be long enough to resist guessing
 * at the rate limit below, and long enough that nobody picks `changeme` and
 * believes the socket is protected. Sixteen characters of printable ASCII is
 * 95 bits at most, comfortably past brute force even at the default budget.
 */
export const MIN_HTTP_TOKEN_LENGTH = 16;

/** How many distinct client addresses get their own rate-limit bucket. */
const MAX_TRACKED_RATE_LIMIT_KEYS = 4096;

/** A configuration refusal. Thrown, never warned — see the header's rule 4. */
export class HttpConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HttpConfigError';
  }
}

export interface HttpConfig {
  /** False means: stay on stdio, and read none of the other fields. */
  readonly enabled: boolean;
  readonly bind: string;
  readonly port: number;
  readonly path: string;
  /** The bearer secret. Never logged, never echoed, never in a response. */
  readonly token: string;
  readonly maxBodyBytes: number;
  readonly rateLimitPerMinute: number;
  readonly maxSessions: number;
  /** True only when the operator ALSO set the non-loopback opt-in. */
  readonly nonLoopbackAllowed: boolean;
}

/** The stdio default. Every field is inert; `token` is empty by construction. */
function disabledConfig(): HttpConfig {
  return {
    enabled: false,
    bind: DEFAULT_HTTP_BIND,
    port: DEFAULT_HTTP_PORT,
    path: DEFAULT_HTTP_PATH,
    token: '',
    maxBodyBytes: DEFAULT_HTTP_MAX_BODY_BYTES,
    rateLimitPerMinute: DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
    maxSessions: DEFAULT_HTTP_MAX_SESSIONS,
    nonLoopbackAllowed: false,
  };
}

/**
 * Is this hostname a loopback address?
 *
 * Accepts `localhost`, the whole of `127.0.0.0/8` and the IPv6 loopback `::1`
 * (bare, or bracketed as `[::1]`). Everything else — including the unspecified
 * addresses `0.0.0.0` and `::`, which is what a listener binds when you ask it
 * to accept every interface — is NOT loopback. That asymmetry is the point: the
 * question this answers is "does a packet to here stay on this machine?", and
 * for the unspecified address the answer is no.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === '') return false;
  if (host === 'localhost') return true;
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (unbracketed === '::1' || unbracketed === '0:0:0:0:0:0:0:1') return true;
  // 127.0.0.0/8. Parsed as four octets rather than matched with a regex so
  // `127.1` and `0127.0.0.1`-style spellings cannot slip past as "loopback".
  const octets = unbracketed.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return Number(octets[0]) === 127;
}

/** Parse an integer env value within `[min, max]`, or refuse with the range named. */
function boundedInt(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpConfigError(
      `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(raw)}).`,
    );
  }
  return parsed;
}

/**
 * Read the bearer secret, and refuse every shape that would leave the listener
 * unauthenticated or the value unrepresentable in a header.
 *
 * The character class is the RFC 7230 `token` production (printable ASCII, no
 * spaces). A secret containing a space could never be sent in an
 * `Authorization` header, and one containing CR or LF is a request-splitting
 * vector — both are configuration errors here rather than a footgun for the
 * operator to discover at the first 401.
 */
function resolveHttpToken(env: NodeJS.ProcessEnv): string {
  const inline = env.SPOTIFY_MCP_HTTP_TOKEN;
  const file = env.SPOTIFY_MCP_HTTP_TOKEN_FILE;
  if (inline !== undefined && file !== undefined) {
    throw new HttpConfigError(
      'Set either SPOTIFY_MCP_HTTP_TOKEN or SPOTIFY_MCP_HTTP_TOKEN_FILE, not both — '
      + 'two sources for one secret means the wrong one can win silently.',
    );
  }
  let token: string;
  let source: string;
  if (inline !== undefined) {
    token = inline.trim();
    source = 'SPOTIFY_MCP_HTTP_TOKEN';
  } else if (file !== undefined && file.trim() !== '') {
    source = 'SPOTIFY_MCP_HTTP_TOKEN_FILE';
    let raw: string;
    const tokenPath = file.trim();
    try {
      raw = readFileSync(tokenPath, 'utf8');
    } catch (error) {
      // The PATH is named here because the underlying error does not always
      // name it (EISDIR carries none), and an operator who cannot tell which
      // file failed cannot fix it. The secret is not, and is not available to
      // be: nothing on this path has read one.
      throw new HttpConfigError(
        `SPOTIFY_MCP_HTTP_TOKEN_FILE could not be read (${tokenPath}): `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // A token file is written by a human with a trailing newline more often
    // than not. Trim exactly one line ending, not all whitespace: a secret is
    // otherwise taken verbatim.
    token = raw.replace(/\r?\n$/, '');
    if (process.platform !== 'win32') {
      try {
        const mode = statSync(tokenPath).mode & 0o777;
        if ((mode & 0o077) !== 0) {
          console.error(
            `[spotify-mcp] warning: ${source} is readable by group or other (mode ${mode.toString(8)}). `
            + 'The bearer token gates a network listener — chmod 600 it.',
          );
        }
      } catch {
        // A file we just read and cannot stat is not worth failing startup over.
      }
    }
  } else {
    throw new HttpConfigError(
      'SPOTIFY_MCP_TRANSPORT=http requires a bearer token: set SPOTIFY_MCP_HTTP_TOKEN, '
      + 'or SPOTIFY_MCP_HTTP_TOKEN_FILE pointing at a file whose first line is the token. '
      + 'There is no default and no anonymous mode — an unauthenticated MCP endpoint '
      + 'enumerates every tool this account can call.',
    );
  }

  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new HttpConfigError(
      `The bearer token from ${source} must be printable ASCII with no spaces `
      + '(a space or CR/LF cannot be sent in an Authorization header).',
    );
  }
  if (token.length < MIN_HTTP_TOKEN_LENGTH) {
    throw new HttpConfigError(
      `The bearer token from ${source} is ${token.length} characters; `
      + `at least ${MIN_HTTP_TOKEN_LENGTH} are required.`,
    );
  }
  return token;
}

/**
 * Resolve the transport configuration from the environment.
 *
 * Pure: it reads `env` and the token FILE, starts no listener, binds no port
 * and registers no tool, so every refusal below is testable without a socket.
 *
 * The stdio branch returns before any other variable is looked at. That is not
 * an optimisation — it is what makes `SPOTIFY_MCP_HTTP_TOKEN` a variable whose
 * absence cannot affect a stdio host. A default path that validated opt-in
 * configuration would refuse to start over a variable it never uses.
 */
export function resolveHttpConfig(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const raw = (env.SPOTIFY_MCP_TRANSPORT ?? '').trim().toLowerCase();
  if (raw === '' || raw === TRANSPORT_STDIO) return disabledConfig();
  if (raw !== TRANSPORT_HTTP) {
    // Fail loud rather than fall back: an operator who asked for a transport
    // this build does not have must not silently get stdio and a process that
    // looks healthy to their host.
    throw new HttpConfigError(
      `Unknown SPOTIFY_MCP_TRANSPORT ${JSON.stringify(env.SPOTIFY_MCP_TRANSPORT)} — `
      + `accepted values are "${TRANSPORT_STDIO}" (the default) and "${TRANSPORT_HTTP}".`,
    );
  }

  const bind = (env.SPOTIFY_MCP_HTTP_BIND ?? DEFAULT_HTTP_BIND).trim() || DEFAULT_HTTP_BIND;
  const loopback = isLoopbackHost(bind);
  const nonLoopbackAllowed = truthyEnv(env.SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK);
  if (!loopback && !nonLoopbackAllowed) {
    throw new HttpConfigError(
      `SPOTIFY_MCP_HTTP_BIND=${bind} is not a loopback address, so it would accept connections `
      + 'from other machines. Loopback is the default and this server has no per-caller identity. '
      + 'If that is genuinely what you want, also set SPOTIFY_MCP_HTTP_ALLOW_NON_LOOPBACK=1 — '
      + 'and put a TLS terminator and a real network boundary in front of it first.',
    );
  }

  const path = (env.SPOTIFY_MCP_HTTP_PATH ?? DEFAULT_HTTP_PATH).trim() || DEFAULT_HTTP_PATH;
  if (!path.startsWith('/')) {
    throw new HttpConfigError(
      `SPOTIFY_MCP_HTTP_PATH must start with "/" (got ${JSON.stringify(env.SPOTIFY_MCP_HTTP_PATH)}).`,
    );
  }

  return {
    enabled: true,
    bind,
    port: boundedInt(env.SPOTIFY_MCP_HTTP_PORT, DEFAULT_HTTP_PORT, 0, 65535, 'SPOTIFY_MCP_HTTP_PORT'),
    path,
    token: resolveHttpToken(env),
    maxBodyBytes: boundedInt(
      env.SPOTIFY_MCP_HTTP_MAX_BODY_BYTES,
      DEFAULT_HTTP_MAX_BODY_BYTES,
      1024,
      64 * 1_048_576,
      'SPOTIFY_MCP_HTTP_MAX_BODY_BYTES',
    ),
    rateLimitPerMinute: boundedInt(
      env.SPOTIFY_MCP_HTTP_RATE_LIMIT,
      DEFAULT_HTTP_RATE_LIMIT_PER_MINUTE,
      1,
      100_000,
      'SPOTIFY_MCP_HTTP_RATE_LIMIT',
    ),
    maxSessions: boundedInt(
      env.SPOTIFY_MCP_HTTP_MAX_SESSIONS,
      DEFAULT_HTTP_MAX_SESSIONS,
      1,
      256,
      'SPOTIFY_MCP_HTTP_MAX_SESSIONS',
    ),
    nonLoopbackAllowed,
  };
}

/**
 * The bearer credential from an `Authorization` header, or null.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive, and a client that sends `bearer` is conformant. The token
 * itself is taken verbatim after exactly one run of spaces/tabs — no
 * normalisation that could make two different strings compare equal.
 */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  // Node joins repeated headers into an array only for some fields; `authorization`
  // is not one of them, but a caller may hand us an array and the shape must not
  // become a bypass.
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  const match = /^[ \t]*[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+([^ \t]+)[ \t]*$/.exec(value);
  return match ? match[1]! : null;
}

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed to a fixed 32 bytes first. `timingSafeEqual` refuses
 * inputs of different lengths, so comparing the raw strings would either throw
 * or force a length branch — and the length of a bearer token is exactly the
 * kind of thing an attacker learns one character at a time. Hashing first makes
 * the comparison constant-length, so a wrong token costs the same as a right
 * one of a different length.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * A token-bucket limiter keyed by client address.
 *
 * ## Why it runs BEFORE authentication
 *
 * The obvious order is authenticate-then-rate-limit. That is wrong here: an
 * unauthenticated attacker gets an unlimited oracle for guessing the token
 * unless the 401 path is itself throttled. Running the check first means a
 * brute-force attempt is met with 429 before it ever reaches the comparison.
 *
 * ## Why addresses beyond the tracking cap SHARE a bucket
 *
 * A per-key map is a memory-exhaustion vector of its own — a client that can
 * spoof source addresses (or a botnet) grows the map until the process dies.
 * Past `MAX_TRACKED_RATE_LIMIT_KEYS` an unseen key is charged to one shared
 * overflow bucket, so flooding with fresh addresses costs the flooder rather
 * than the server. Sweeping expired buckets first keeps honest clients from
 * being pushed into it by long-lived connections.
 */
export class RequestRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private overflow: { tokens: number; updatedAt: number };
  private readonly now: () => number;

  constructor(
    rateLimitPerMinute: number,
    options: { now?: () => number; capacity?: number } = {},
  ) {
    this.refillPerMs = rateLimitPerMinute / 60_000;
    this.capacity = options.capacity ?? Math.max(1, Math.ceil(rateLimitPerMinute / 60));
    this.now = options.now ?? Date.now;
    this.overflow = { tokens: this.capacity, updatedAt: this.now() };
  }

  /** Live per-address buckets. Exposed so the tracking cap is testable. */
  get trackedKeys(): number {
    return this.buckets.size;
  }

  tryConsume(key: string, cost = 1): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_TRACKED_RATE_LIMIT_KEYS) this.sweep(now);
      if (this.buckets.size < MAX_TRACKED_RATE_LIMIT_KEYS) {
        bucket = { tokens: this.capacity, updatedAt: now };
        this.buckets.set(key, bucket);
      } else {
        bucket = this.overflow;
      }
    }
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = now;
    if (bucket.tokens < cost) return false;
    bucket.tokens -= cost;
    return true;
  }

  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens >= this.capacity) this.buckets.delete(key);
    }
    const elapsed = Math.max(0, now - this.overflow.updatedAt);
    this.overflow = {
      tokens: Math.min(this.capacity, this.overflow.tokens + elapsed * this.refillPerMs),
      updatedAt: now,
    };
  }
}

export type BodyResult =
  | { ok: true; raw: string }
  | { ok: false; status: number; message: string };

/**
 * How many bytes past the ceiling are still read and discarded.
 *
 * ## Why an oversized body is DRAINED and not aborted
 *
 * Answering 413 the moment the count passes the limit — by destroying the
 * request, or by ending the response while the peer is still writing — makes
 * Node reset the connection, and the client sees ECONNRESET rather than the 413
 * that was just composed. Measured on this tree, both variants lose the status
 * line; a body left unread in the socket's receive buffer is what produces the
 * reset.
 *
 * So the bytes past the ceiling are read and THROWN AWAY. That is not a hole in
 * the ceiling: nothing is buffered past it, so the memory bound holds, and the
 * cost is bandwidth the attacker is already paying. A second, much larger cap
 * bounds even that, and past it the socket is destroyed — at which point the
 * reset is the correct answer, because the peer is sending an unbounded body.
 */
const DRAIN_CEILING_FACTOR = 8;

/** Buffer a request body under a hard byte ceiling, discarding the overflow. */
export function readBodyLimited(req: IncomingMessage, limit: number): Promise<BodyResult> {
  const declared = req.headers['content-length'];
  if (typeof declared === 'string' && declared.trim() !== '') {
    const claimed = Number(declared);
    if (Number.isFinite(claimed) && claimed > limit) {
      return Promise.resolve({
        ok: false,
        status: 413,
        message: `request body exceeds the ${limit}-byte ceiling`,
      });
    }
  }

  return new Promise<BodyResult>((resolve) => {
    const drainCeiling = limit * DRAIN_CEILING_FACTOR;
    const kept: Buffer[] = [];
    let total = 0;
    let over = false;
    let settled = false;

    const finish = (result: BodyResult): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(result);
    };
    function onData(chunk: Buffer): void {
      total += chunk.length;
      if (total > limit) {
        over = true;
        kept.length = 0; // release the prefix rather than hold it forever
        if (total > drainCeiling) {
          req.destroy();
          finish({ ok: false, status: 413, message: `request body exceeds the ${limit}-byte ceiling` });
        }
        return;
      }
      kept.push(chunk);
    }
    function onEnd(): void {
      finish(over
        ? { ok: false, status: 413, message: `request body exceeds the ${limit}-byte ceiling` }
        : { ok: true, raw: Buffer.concat(kept).toString('utf8') });
    }
    function onError(): void {
      finish({ ok: false, status: 400, message: 'request body could not be read' });
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** A refusal with no detail: a 401 that explains itself helps an attacker. */
function sendBare(res: ServerResponse, status: number, headers: Record<string, string>, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

export interface HttpTransportOptions {
  readonly config: HttpConfig;
  /** Builds a fresh, fully-registered McpServer. One per session. */
  readonly createServer: () => Promise<McpServer>;
  /** Where startup and refusals go. stderr by default; never the token. */
  readonly log?: (message: string) => void;
}

export interface HttpTransportHandle {
  /** The bound URL, with the configured path. Safe to print: no token in it. */
  readonly url: string;
  readonly port: number;
  readonly sessionCount: () => number;
  close: () => Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

/**
 * Start the listener.
 *
 * Resolves only once the socket is bound, so a caller that awaits this can
 * connect without polling. `port: 0` binds a kernel-assigned port and reports
 * it back through `port` and `url` — which is what the tests use, and the only
 * way to be safe on a host where a dozen agents are running the same suite.
 */
export async function startHttpTransport(options: HttpTransportOptions): Promise<HttpTransportHandle> {
  const { config } = options;
  const log = options.log ?? ((message: string) => console.error(`[spotify-mcp] ${message}`));
  const { StreamableHTTPServerTransport: Transport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const sessions = new Map<string, Session>();
  const limiter = new RequestRateLimiter(config.rateLimitPerMinute);
  // Keep-alive sockets outlive a request, so `server.close()` alone waits for
  // them and a shutdown hangs. Tracked and destroyed explicitly.
  const sockets = new Set<Socket>();
  // An initialize is in flight between the cap check and `onsessioninitialized`,
  // and building the registry is an await. Without this the cap is advisory:
  // N simultaneous first-requests all pass the check before any of them lands.
  let pending = 0;

  const clientKey = (req: IncomingMessage): string => req.socket.remoteAddress ?? 'unknown';

  /** The hostname in a Host header, with any port and IPv6 brackets removed. */
  function hostnameOf(hostHeader: string): string {
    const host = hostHeader.trim();
    if (host.startsWith('[')) {
      const end = host.indexOf(']');
      return end === -1 ? host.slice(1) : host.slice(1, end);
    }
    return host.split(':')[0] ?? '';
  }

  /**
   * Host-header validation, which exists for DNS rebinding.
   *
   * A browser page on `evil.example` can resolve a name to 127.0.0.1 and have
   * the victim's own browser issue requests to this listener. The bearer token
   * is the real defence — a page cannot read it — but a loopback listener that
   * accepts a foreign `Host` is one `fetch` away from being probed, and the SDK
   * deprecated its own `allowedHosts` option in favour of exactly this
   * middleware. Only enforced for a loopback bind: an operator who explicitly
   * opened the listener to a network owns Host validation for that deployment.
   */
  const hostAllowed = (req: IncomingMessage): boolean => {
    if (isLoopbackHost(config.bind)) return true;
    const host = req.headers.host;
    if (typeof host !== 'string') return false;
    return isLoopbackHost(hostnameOf(host));
  };

  const closeSession = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    sessions.delete(id);
    if (!session) return;
    try {
      await session.transport.close();
    } catch {
      // A transport that throws on close must not strand the server instance.
    }
    try {
      await session.server.close();
    } catch {
      // Same: the registry is being discarded either way.
    }
  };

  /**
   * Build a session: a fresh, fully-registered McpServer plus its transport.
   *
   * Returns the transport whether or not the body turned out to be an
   * initialize — the transport itself answers a non-initialize POST with the
   * right 400, and the caller disposes of the registry afterwards. Returning
   * null here means the session cap, and only that.
   */
  const newSession = async (): Promise<StreamableHTTPServerTransport | null> => {
    if (sessions.size + pending >= config.maxSessions) return null;
    pending += 1;
    try {
      const server = await options.createServer();
      const transport = new Transport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport, server });
          log(`http session opened (${sessions.size}/${config.maxSessions})`);
        },
        onsessionclosed: (sessionId) => {
          log(`http session closed (${sessions.size - 1}/${config.maxSessions})`);
          void closeSession(sessionId);
        },
      });
      await server.connect(transport);
      return transport;
    } finally {
      pending -= 1;
    }
  };

  const readJsonBody = async (req: IncomingMessage): Promise<
    { ok: true; value: unknown } | { ok: false; status: number; message: string }
  > => {
    const body = await readBodyLimited(req, config.maxBodyBytes);
    if (!body.ok) return { ok: false, status: body.status, message: body.message };
    try {
      return { ok: true, value: JSON.parse(body.raw) };
    } catch {
      return { ok: false, status: 400, message: 'malformed JSON-RPC body' };
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path !== config.path) {
      sendBare(res, 404, {}, 'not found\n');
      return;
    }

    // Rate limit BEFORE the credential check, so guessing the token is itself
    // throttled. See RequestRateLimiter's header for why the order is this one.
    if (!limiter.tryConsume(clientKey(req))) {
      sendBare(res, 429, { 'retry-after': '60' }, 'rate limited\n');
      return;
    }

    // Authenticate BEFORE the method, before a session exists, and before any
    // registry is built. Everything below this line can disclose the tool
    // surface; nothing above it can.
    const presented = extractBearerToken(req.headers.authorization);
    if (presented === null || !secretsMatch(presented, config.token)) {
      sendBare(res, 401, { 'www-authenticate': 'Bearer realm="spotify-mcp"' }, 'unauthorized\n');
      return;
    }

    if (!hostAllowed(req)) {
      sendBare(res, 403, {}, 'forbidden\n');
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const header = req.headers['mcp-session-id'];
    const sessionId = typeof header === 'string' && header !== '' ? header : null;
    const existing = sessionId === null ? undefined : sessions.get(sessionId);

    if (method === 'GET' || method === 'DELETE') {
      if (!existing || sessionId === null) {
        sendBare(res, 404, {}, 'unknown session\n');
        return;
      }
      if (method === 'DELETE') {
        await closeSession(sessionId);
        sendBare(res, 200, {}, 'session closed\n');
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    if (method !== 'POST') {
      sendBare(res, 405, { allow: 'GET, POST, DELETE' }, 'method not allowed\n');
      return;
    }

    // A POST carrying a session id must name a live one. An unknown id is a 404
    // rather than a new session: silently starting one would let a client that
    // lost its session state mint unlimited registries.
    if (sessionId !== null) {
      if (!existing) {
        sendBare(res, 404, {}, 'unknown session\n');
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendBare(res, body.status, {}, `${body.message}\n`);
        return;
      }
      await existing.transport.handleRequest(req, res, body.value);
      return;
    }

    // No session id: this must be an initialize. Build a session for it.
    const body = await readJsonBody(req);
    if (!body.ok) {
      sendBare(res, body.status, {}, `${body.message}\n`);
      return;
    }

    const transport = await newSession();
    if (transport === null) {
      sendBare(res, 503, { 'retry-after': '5' }, 'session limit reached\n');
      return;
    }
    await transport.handleRequest(req, res, body.value);
    // A body that was not an initialize makes the transport refuse it, and
    // `onsessioninitialized` never fires. The half-built registry is then
    // unreachable, so it is discarded here rather than leaked one per request.
    if (transport.sessionId === undefined) {
      try {
        await transport.close();
      } catch {
        // Nothing to do: the transport never opened.
      }
    }
  };

  const http: HttpServer = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      // A refusal that throws is a 500, never an unhandled rejection: an
      // unhandled one would take the process down, and the process serves every
      // other live session.
      log(`http request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendBare(res, 500, {}, 'internal error\n');
      else res.end();
    });
  });
  // Registered once, not per request: a `connection` listener added inside the
  // request handler would accumulate one per request and is itself a leak.
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, config.bind, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const address = http.address() as AddressInfo | null;
  const port = address?.port ?? config.port;
  const hostForUrl = config.bind.includes(':') ? `[${config.bind}]` : config.bind;

  return {
    url: `http://${hostForUrl}:${port}${config.path}`,
    port,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all([...sessions.keys()].map(closeSession));
      sessions.clear();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
