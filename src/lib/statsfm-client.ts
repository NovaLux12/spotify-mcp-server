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

export const STATSFM_BASE_URL = 'https://api.stats.fm/api/v1';

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

function retryAfterSeconds(headers: Headers): number | undefined {
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
  const direct = 'reason' in body ? (body as { reason: unknown }).reason : undefined;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if ('error' in body && body.error && typeof body.error === 'object' && 'reason' in body.error) {
    const nested = (body.error as { reason: unknown }).reason;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  return undefined;
}

export type StatsfmFetch = (url: string) => Promise<Response>;

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
      throw new StatsfmApiError(0, 'stats.fm request failed', undefined, 'transport_error');
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const msg =
        body && typeof body === 'object' && 'message' in body && typeof (body as { message: unknown }).message === 'string'
          ? (body as { message: string }).message
          : `stats.fm HTTP ${res.status}`;
      throw new StatsfmApiError(res.status, msg, retryAfterSeconds(res.headers), errorReason(body));
    }
    // Error envelope with a 200 status (stats.fm sometimes does this).
    if (body && typeof body === 'object' && 'status' in body && 'message' in body) {
      const env = body as { status: unknown; message: unknown };
      if (typeof env.status === 'number' && env.status >= 400 && typeof env.message === 'string') {
        const retry = validRetryAfter((body as { retryAfterSec?: unknown }).retryAfterSec);
        throw new StatsfmApiError(env.status, env.message, retry, errorReason(body));
      }
    }
    return body as T | null;
  }
}

/** `{ item: T }` envelope helpers for single-resource responses. */
export function unwrapItem<T>(body: { item?: T | null } | null): T | null {
  if (!body || typeof body !== 'object') return null;
  return body.item ?? null;
}

/** `{ items: T[] }` envelope helpers for collection responses. */
export function unwrapItems<T>(body: { items?: T[] } | null): T[] {
  if (!body || typeof body !== 'object') return [];
  return Array.isArray(body.items) ? body.items : [];
}
