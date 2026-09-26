/**
 * Minimal client for the public stats.fm API (https://api.stats.fm/api/v1).
 *
 * stats.fm is a third-party listening-stats service — no OAuth, no Spotify
 * token needed. All calls are unauthenticated GETs, so every tool built on
 * this client is read-only and stays visible under SPOTIFY_MCP_READONLY.
 *
 * Response envelope conventions (verified live 2026-09-05):
 *   - single resources → `{ "item": {...} }` (or `{ "item": null }`)
 *   - collections      → `{ "items": [...] }`
 *   - errors           → `{ "status": <http>, "path": ..., "message": ... }`
 */

const STATSFM_BASE_URL = 'https://api.stats.fm/api/v1';

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

/**
 * Same policy for callers that hold a raw `Response`: Retry-After is honoured
 * (header, else the envelope's own hint), the upstream message is dropped, and
 * only the reason code survives. One implementation, so a second copy cannot
 * drift back into surfacing the envelope text.
 */
export function statsfmApiErrorFromHttp(status: number, body: unknown, headers: Headers): StatsfmApiError {
  const bodyRetry = body && typeof body === 'object' && 'retryAfterSec' in body
    ? (body as { retryAfterSec: unknown }).retryAfterSec
    : undefined;
  return statsfmApiErrorFromResponse(status, body, validRetryAfter(bodyRetry) ?? statsfmRetryAfterSec(headers));
}

/** Convert a failed fetch operation into the shared redacted transport type. */
export function statsfmTransportError(): StatsfmApiError {
  return new StatsfmApiError(0, 'stats.fm request failed', undefined, 'transport_error');
}

type StatsfmFetch = (url: string) => Promise<Response>;

export class StatsfmClient {
  private readonly fetchFn: StatsfmFetch;

  constructor(fetchFn?: StatsfmFetch) {
    // `fetchFn ?? fetch` would capture the global at construction time in
    // some bundlers; resolve lazily so tests can stub global fetch.
    this.fetchFn = fetchFn ?? ((url: string) => fetch(url));
  }

  /**
   * GET `path` (leading slash, no base) with optional query params.
   * Returns the decoded JSON body, or null on transport-level emptiness.
   * Throws StatsfmApiError when the API signals an error envelope or a
   * non-2xx HTTP status.
   */
  async get<T = unknown>(path: string, params?: Record<string, string | number>): Promise<T | null> {
    const qs = params
      ? '?' +
        Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&')
      : '';
    const url = `${STATSFM_BASE_URL}${path}${qs}`;
    let res: Response;
    try {
      res = await this.fetchFn(url);
    } catch (err) {
      if (err instanceof StatsfmApiError) throw err;
      throw statsfmTransportError();
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
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
    return body as T | null;
  }
}
