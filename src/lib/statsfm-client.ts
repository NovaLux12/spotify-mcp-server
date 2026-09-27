/**
 * The one stats.fm HTTP client (#907).
 *
 * stats.fm is a third-party listening-stats service — no OAuth, no Spotify
 * token needed. All calls are unauthenticated GETs, so every tool built on
 * this client is read-only and stays visible under SPOTIFY_MCP_READONLY.
 *
 * This module is the ONLY place that may talk to stats.fm over HTTP. It used
 * to be one of three parallel stacks: `statsfm_taste.ts` and
 * `taste_composites.ts` each carried a private base-URL constant and a private
 * bare `fetch` with no timeout, and the sibling `statsfm.ts` tools ran through
 * this client while bypassing its cache entirely. A tool session therefore
 * re-downloaded the same ~124 KB `/users/{u}/streams` payload once per taste
 * tool, and a stalled stats.fm response blocked forever because nothing
 * aborted it. Consolidating here is what makes the timeout, the retry and the
 * cache apply to every call site instead of to a minority of them.
 *
 * Response envelope conventions (verified live 2026-09-05):
 *   - single resources → `{ "item": {...} }` (or `{ "item": null }`)
 *   - collections      → `{ "items": [...] }`
 *   - errors           → `{ "status": <http>, "path": ..., "message": ... }`
 */
import { LruTtlCache } from '../cache.js';
import { getConfig } from '../config.js';

const STATSFM_BASE_URL = 'https://api.stats.fm/api/v1';

/**
 * Cache lifetime. Deliberately much shorter than the Spotify catalogue cache
 * (5 min, `src/cache.ts`): a stream is appended the moment it is played, so a
 * `taste_daily_brief` must never answer from a list that predates the session
 * that asked for it. Two minutes is long enough that the ~124 KB streams page
 * is fetched once per session rather than once per tool, and short enough that
 * a stale read is not the last word of the day.
 */
const DEFAULT_TTL_MS = 2 * 60_000;

/**
 * stats.fm is a small third-party service with a shared, unauthenticated
 * request pool. A generous entry count here would mostly evict itself.
 */
const DEFAULT_MAX_ENTRIES = 64;

/**
 * Total dispatches one logical read may consume. The issue asks for "one retry
 * on 429/5xx", and that is all a public, uncredentialed third-party read earns:
 * an unbounded backoff against a permanently unhealthy stats.fm is its own
 * outage, and a tight retry loop earns a rate limit.
 */
const MAX_ATTEMPTS = 2;

/** Backoff base for a retryable status with no usable `Retry-After` (#675 parity). */
const RETRY_BACKOFF_BASE_MS = 250;

/**
 * Longest single wait this client will hold for a `Retry-After`. Past this the
 * caller gets the error with the advertised wait still attached, rather than a
 * tool that has said nothing for a minute.
 */
const RETRY_SLEEP_CAP_SEC = 10;

/**
 * Statuses worth a second attempt. 429 is the case the issue names; 502/503/504
 * are the gateway/upstream failures where a re-send is free — every stats.fm
 * call is an idempotent GET. 500 is deliberately absent for the same reason
 * `src/client.ts` omits it: it is the server's own logic failing.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Sent on every request. stats.fm serves unauthenticated JSON only.
 *
 * The product token is this project's own name, and the trailing comment is a
 * contact URL — the convention RFC 9110 §10.1.5 sets out for a UA that has
 * nobody to complain to otherwise. It deliberately does NOT name stats.fm
 * (#698). stats.fm's Terms Sec. 7.1(g) forbids using their name, logo or
 * trademarks "without our prior written consent", and Sec. 4.3 asserts those
 * rights over exactly this string. An earlier value here read
 * `spotify-mcp/statsfm`, which advertised a third party's name on every
 * outbound request with no recorded consent, and misdescribed the client: the
 * caller is this server, not stats.fm. Naming the upstream service buys
 * nothing operationally — every request still arrives with stats.fm's own
 * response headers — and costs a term.
 *
 * No version suffix. Reading `package.json` for one means a relative path that
 * is correct from `src/lib/` and wrong from `dist/lib/`, and a UA that throws
 * because a path is off by one directory is worse than a UA without a version.
 */
const STATSFM_USER_AGENT = 'spotify-mcp (+https://github.com/NovaLux12/spotify-mcp-server)';

export class StatsfmApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly retryAfterSec?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = 'StatsfmApiError';
  }
}

function validRetryAfter(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.ceil(value) : undefined;
}

function statsfmRetryAfterSec(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const seconds = validRetryAfter(Number(value));
  if (seconds !== undefined) return seconds;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function errorReason(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if ('reason' in body && typeof body.reason === 'string' && body.reason.length > 0) return body.reason;
  if ('error' in body && body.error && typeof body.error === 'object' && 'reason' in body.error) {
    const nested = body.error.reason;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}

/**
 * Build a public-safe stats.fm failure. Error-envelope messages are deliberately
 * excluded because stats.fm may echo private request paths or query values.
 */
function statsfmApiErrorFromResponse(
  status: number,
  body: unknown,
  retryAfterSec?: number,
): StatsfmApiError {
  return new StatsfmApiError(
    status,
    `stats.fm HTTP ${status}`,
    validRetryAfter(retryAfterSec),
    errorReason(body),
  );
}

/** Convert a failed fetch operation into the shared redacted transport type. */
export function statsfmTransportError(): StatsfmApiError {
  return new StatsfmApiError(0, 'stats.fm request failed', undefined, 'transport_error');
}

/**
 * The transport a client calls. `init` carries the abort signal and headers;
 * an injected stub may ignore it — the timeout is enforced by the client
 * itself, not delegated here (see {@link StatsfmClient.attempt}), so a stub that
 * ignores `init` still fails instead of hanging.
 */
export type StatsfmFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface StatsfmClientOptions {
  /** Transport. Default: the global `fetch`, resolved at call time. */
  fetchFn?: StatsfmFetch;
  /**
   * Per-attempt ceiling in ms. Default: `getConfig().spotifyRequestTimeoutMs`,
   * read per call so a re-bound config applies without rebuilding the client.
   * This is the same knob the Spotify request funnel uses (#880) — a third
   * setting would just be a third thing to remember to change.
   */
  timeoutMs?: number;
  /** Cache entry lifetime. Default 2 minutes. */
  ttlMs?: number;
  /** Cache entry ceiling. Default 64. */
  maxEntries?: number;
  /** Set false to bypass the cache (per-instance opt-out). */
  cache?: boolean;
  /** Backoff wait. Injected by tests so a retry costs no wall-clock time. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Parsed body plus its exact serialized size, so the cache is not re-measuring. */
type FetchedBody = { body: unknown; bytes: number };

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bound the whole attempt — response headers AND body — not just the socket
 * open. `fetch` resolves as soon as the headers arrive, so racing only the
 * `fetch` call would leave a server that sends headers and then stalls on the
 * 124 KB body unbounded, which is the exact failure #907 describes.
 */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(onTimeout());
    }, timeoutMs);
  });
  return Promise.race([work(controller.signal), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * An unparseable or empty body is `null`, not a thrown error. That is a
 * deliberate reading of the envelope contract, unchanged from the pre-#907
 * client: stats.fm answers `204`/empty for some reads, and a caller that
 * cannot parse a 200 is better served by the same "nothing here" answer than by
 * a transport-shaped error it cannot act on. An unparseable body is never
 * cached, so a single bad response cannot become a 2-minute answer.
 */
function parseJsonBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function buildQuery(params?: Record<string, string | number>): string {
  // A params object that filters down to nothing still yields a bare `?`,
  // which stats.fm parses as an empty query rather than a malformed one.
  if (!params) return '';
  return (
    '?' +
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
  );
}

export class StatsfmClient {
  private readonly fetchFn: StatsfmFetch;
  private readonly timeoutMs: number | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly cache: LruTtlCache<unknown> | null;

  constructor(fetchFn?: StatsfmFetch, opts: StatsfmClientOptions = {}) {
    // A `fetchFn ?? fetch` default would capture the global at construction
    // time in some bundlers and in `tests/statsfm.test.ts`, which swaps
    // `globalThis.fetch`; resolve it per call instead.
    this.fetchFn = fetchFn ?? opts.fetchFn ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs;
    this.sleepFn = opts.sleepFn ?? timerSleep;
    this.cache = opts.cache === false
      ? null
      : new LruTtlCache<unknown>({
          ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
          maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
        });
  }

  /**
   * GET `path` (leading slash, no base) with optional query params.
   * Returns the decoded JSON body, or null on transport-level emptiness.
   * Throws StatsfmApiError when the API signals an error envelope or a
   * non-2xx HTTP status, or when the attempt exceeds the configured timeout.
   *
   * Successful bodies are cached for {@link DEFAULT_TTL_MS} under path+params,
   * so the read that ~ten taste tools each want happens once (#907).
   */
  async get<T = unknown>(path: string, params?: Record<string, string | number>): Promise<T | null> {
    // The cache is keyed on the path+query, never on the absolute URL: the
    // base is the one constant above it, so keying on the full URL would only
    // add a prefix that cannot vary.
    const key = `${path}${buildQuery(params)}`;
    const hit = this.cache?.get(key);
    // `null` is never stored, so a defined read is always a real hit.
    if (hit !== undefined) return hit as T;

    const { body, bytes } = await this.fetchBody(`${STATSFM_BASE_URL}${key}`);
    if (this.cache && body !== null) this.cache.set(key, body, { bytes });
    return body as T | null;
  }

  private resolveTimeoutMs(): number {
    return this.timeoutMs ?? getConfig().spotifyRequestTimeoutMs;
  }

  /** One dispatch, up to {@link MAX_ATTEMPTS} with a backoff between them. */
  private async fetchBody(url: string): Promise<FetchedBody> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attempt(url);
      } catch (err) {
        const error = err instanceof StatsfmApiError ? err : statsfmTransportError();
        if (attempt >= MAX_ATTEMPTS || !RETRYABLE_STATUSES.has(error.status)) throw error;
        await this.sleepFn(backoffMs(error, attempt));
      }
    }
  }

  private async attempt(url: string): Promise<FetchedBody> {
    const timeoutMs = this.resolveTimeoutMs();
    let res: Response;
    let text: string;
    try {
      res = await withDeadline(
        (signal) => this.fetchFn(url, {
          method: 'GET',
          headers: { accept: 'application/json', 'user-agent': STATSFM_USER_AGENT },
          signal,
        }),
        timeoutMs,
        // Message is status-shaped like every other stats.fm error here: the
        // URL can carry a user's private profile path, so it is not echoed.
        () => new StatsfmApiError(
          408,
          `stats.fm request timed out after ${Math.round(timeoutMs / 1000)}s`,
          undefined,
          'timeout',
        ),
      );
      text = await withDeadline(
        () => res.text(),
        timeoutMs,
        () => new StatsfmApiError(
          408,
          `stats.fm response body timed out after ${Math.round(timeoutMs / 1000)}s`,
          undefined,
          'timeout',
        ),
      );
    } catch (err) {
      if (err instanceof StatsfmApiError) throw err;
      throw statsfmTransportError();
    }

    const body = parseJsonBody(text);
    if (!res.ok) {
      throw statsfmApiErrorFromResponse(res.status, body, statsfmRetryAfterSec(res.headers));
    }
    // Error envelope with a 200 status (stats.fm sometimes does this).
    if (body && typeof body === 'object' && 'status' in body && 'message' in body) {
      const env = body as { status: unknown; message: unknown; retryAfterSec?: unknown };
      if (typeof env.status === 'number' && env.status >= 400 && typeof env.message === 'string') {
        throw statsfmApiErrorFromResponse(env.status, body, validRetryAfter(env.retryAfterSec));
      }
    }
    return { body, bytes: Buffer.byteLength(text, 'utf8') };
  }
}

/** Wait before attempt `attempt + 1`: the advertised `Retry-After`, else exponential backoff. */
function backoffMs(error: StatsfmApiError, attempt: number): number {
  if (typeof error.retryAfterSec === 'number') {
    return Math.min(error.retryAfterSec, RETRY_SLEEP_CAP_SEC) * 1000;
  }
  return RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1);
}

/**
 * Adapt a legacy parsed-payload test seam (`(url) => Promise<parsed JSON>`) into
 * a `fetchFn`, so the existing fixture suites keep their hermetic per-module
 * stubs while the request itself still travels the client's real timeout, retry
 * and cache path (#907). The seam's own thrown errors reach the client as a
 * rejected fetch, which is exactly the transport-failure shape they assert.
 */
export function statsfmFetchFromPayloadImpl(
  impl: (url: string) => Promise<unknown>,
): StatsfmFetch {
  return async (url) => {
    const payload = await impl(url);
    return new Response(payload === undefined ? '' : JSON.stringify(payload) ?? '', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

// ---------------------------------------------------------------------------
// The one process-wide client
// ---------------------------------------------------------------------------

let sharedInstance: StatsfmClient | undefined;
let activeClient: StatsfmClient | undefined;
let sleepImpl: (ms: number) => Promise<void> = timerSleep;

/**
 * The client every stats.fm tool module resolves its reads through.
 *
 * There has to be exactly one, not one per module: a per-module client means a
 * per-module cache, and the payload the ten taste tools all want is then
 * downloaded ten times — the defect #907 exists to close. Modules that accept a
 * client (the registrars do, for testing) still default to this one.
 */
export function statsfmClient(): StatsfmClient {
  if (activeClient) return activeClient;
  sharedInstance ??= new StatsfmClient(undefined, { sleepFn: (ms) => sleepImpl(ms) });
  return sharedInstance;
}

/**
 * Test seam: swap the client every stats.fm module reads through, or pass
 * nothing to restore a freshly built shared one (which also empties its cache,
 * so a suite that stubs `globalThis.fetch` cannot be answered from a previous
 * test's read).
 */
export function __setStatsfmClient(client?: StatsfmClient): void {
  activeClient = client;
  if (!client) sharedInstance = undefined;
}

/** Test seam: restore the shared client. Alias of `__setStatsfmClient()` with no argument. */
export function __resetStatsfmClient(): void {
  __setStatsfmClient(undefined);
}

/**
 * Test seam: replace the retry backoff wait. The shared client is built once and
 * caches its sleep function, so this rebinds the module-level default rather
 * than a per-client field.
 */
export function __setStatsfmSleepImpl(fn: (ms: number) => Promise<void>): void {
  sleepImpl = fn;
}

/** Test seam: restore the real timer-based backoff wait. */
export function __resetStatsfmSleepImpl(): void {
  sleepImpl = timerSleep;
}
