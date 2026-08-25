import { loadTokens, saveTokens } from './auth.js';

const BASE_URL = 'https://api.spotify.com/v1';
import type { TokenData, SpotifyPaged } from './types/spotify.js';

// Per-request timeout in milliseconds. Every outbound HTTP call (API requests,
// token refresh) carries an AbortSignal.timeout so a hung connection (network
// change, VPN drop) cannot stall the serialized request queue forever.
// Override with SPOTIFY_REQUEST_TIMEOUT_MS.
const REQUEST_TIMEOUT_MS = (() => {
  const parsed = Number.parseInt(process.env.SPOTIFY_REQUEST_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
})();

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    // We own the signal, so an abort here can only be our own timeout.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new SpotifyApiError(
        408,
        `${init.method ?? 'GET'} ${url} timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s`,
      );
    }
    throw err;
  }
}

export class SpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SpotifyApiError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-status fallback message — used only when Spotify returns no structured
// error body (or returns one without a `message` field). Each message is
// intentionally non-prescriptive: it names the likely cause categories rather
// than asserting one specific reason.
function genericMessageFor(status: number): string {
  if (status === 403) {
    // 403 from Spotify has many possible causes — insufficient OAuth scope,
    // deprecated endpoint (e.g. /v1/audio-features after 2024-11-27),
    // regional restriction, or a genuine Premium requirement for playback
    // control. Don't assert "requires Premium" outright.
    return (
      'Spotify returned 403 — usually an OAuth scope, deprecated endpoint, or ' +
      'content restriction (not always a Premium requirement). If you just ' +
      'added scopes, re-run "spotify-mcp auth" to refresh the token.'
    );
  }
  if (status === 404) {
    return 'The requested resource was not found on Spotify';
  }
  if (status === 503) {
    return 'Spotify service is temporarily unavailable — try again shortly';
  }
  return `Spotify API error ${status}`;
}

export class SpotifyClient {
  private tokens: TokenData | null = null;
  private loadPromise: Promise<TokenData> | null = null;

  // Rate limiting
  private _queue: Promise<unknown> = Promise.resolve();
  private _lastRequestTime = 0;
  private _rateLimitUntil = 0;

  private getTokens(): Promise<TokenData> {
    if (!this.loadPromise) {
      this.loadPromise = loadTokens().then(
        (t) => {
          this.tokens = t;
          return t;
        },
        (err) => {
          // Don't cache the rejection — let the next call retry from disk
          // (e.g. after the user re-runs "spotify-mcp auth").
          this.loadPromise = null;
          throw err;
        },
      );
    }
    return this.loadPromise;
  }

  private async ensureValidToken(): Promise<void> {
    const tokens = await this.getTokens();
    if (Date.now() >= tokens.expires_at - 60_000) {
      await this.doRefreshTokens();
    }
  }

  private async doRefreshTokens(): Promise<void> {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) throw new Error('SPOTIFY_CLIENT_ID environment variable is not set');

    const tokens = this.tokens!;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });

    const res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      throw new SpotifyApiError(res.status, 'Token refresh failed — re-run "spotify-mcp auth"');
    }

    const data = await res.json() as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000,
    };

    await saveTokens(this.tokens);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const promise = this._queue.then(async () => {
      const now = Date.now();
      const rateLimitWait = Math.max(0, this._rateLimitUntil - now);
      const gapWait = Math.max(0, this._lastRequestTime + 100 - now);
      const waitMs = Math.max(rateLimitWait, gapWait);
      if (waitMs > 0) await sleep(waitMs);
      this._lastRequestTime = Date.now();
      return fn();
    });
    // Prevent a rejected promise from poisoning the queue chain
    this._queue = promise.catch(() => undefined);
    return promise;
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = `${BASE_URL}${path}`;
    if (!params || Object.keys(params).length === 0) return url;
    return `${url}?${new URLSearchParams(params)}`;
  }

  private async rawRequest(
    method: string,
    url: string,
    body?: unknown,
    retryCount = 0,
    contentType?: string,
  ): Promise<Response> {
    await this.ensureValidToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens!.access_token}`,
    };
    if (contentType !== undefined) {
      headers['Content-Type'] = contentType;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetchWithTimeout(url, {
      method,
      headers,
      body: body === undefined
        ? undefined
        : contentType !== undefined
          ? String(body)
          : JSON.stringify(body),
    });

    // Token expired mid-flight — refresh and retry once
    if (res.status === 401 && retryCount === 0) {
      await this.doRefreshTokens();
      return this.rawRequest(method, url, body, retryCount + 1, contentType);
    }

    // Rate limited — wait and retry once
    if (res.status === 429 && retryCount === 0) {
      // Parse defensively: a garbage header must not yield NaN, which would
      // permanently poison _rateLimitUntil and disable backoff.
      const raw = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      const retryAfter = Number.isFinite(raw) && raw >= 0 ? raw : 1;
      this._rateLimitUntil = Date.now() + retryAfter * 1000;
      await sleep(retryAfter * 1000);
      return this.rawRequest(method, url, body, retryCount + 1, contentType);
    }

    if (!res.ok) {
      // Always try to surface Spotify's own error message first — it's the
      // most accurate diagnostic (e.g. "Audio analysis is not available for
      // this account", "Player command failed: Premium required"). Only fall
      // back to a generic mapping if Spotify gave us no structured body.
      //
      // Pre-fix, ANY HTTP 403 was rewritten to "This action requires Spotify
      // Premium" — which is wrong for the many cases where 403 actually means
      // insufficient OAuth scope, a deprecated endpoint, regional restriction,
      // or a control failure (issues #6 etc.).
      let message: string;
      try {
        const errBody = (await res.json()) as {
          error?: { message?: string; reason?: string };
        };
        const spotifyMsg = errBody.error?.message;
        if (spotifyMsg && spotifyMsg.trim().length > 0) {
          message = spotifyMsg;
        } else {
          message = genericMessageFor(res.status);
        }
      } catch {
        // Response body wasn't JSON — fall back to the per-status hint.
        message = genericMessageFor(res.status);
      }
      throw new SpotifyApiError(res.status, message);
    }

    return res;
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    const url = this.buildUrl(path, params);
    return this.enqueue(async () => {
      const res = await this.rawRequest('GET', url);
      if (res.status === 204) return null;
      try {
        return (await res.json()) as T;
      } catch (err) {
        if (err instanceof SyntaxError) {
          // Body was not valid JSON. Best-effort drain so the connection can
          // be reused, then fail with an actionable error.
          await res.text().catch(() => undefined);
          throw new SpotifyApiError(res.status, `GET ${path} returned a non-JSON body`);
        }
        throw err;
      }
    });
  }

  /**
   * Walk an offset-paginated list endpoint (responses shaped like
   * SpotifyPaged: items[], total, limit, offset, next) and accumulate every
   * item, going through the same rate-limited request queue as get().
   *
   * Stops when the cursor reaches the server-reported `total`; when a
   * response omits `total`, keeps walking until a short/empty page is
   * returned. `maxItems` (default 500) caps collection either way.
   * `opts.initialOffset` seeds the cursor so callers resuming mid-list
   * continue from there instead of restarting at offset 0. Cursor-paginated
   * endpoints (e.g. followed artists, which use an `after` cursor instead of
   * offset/total) are NOT supported by this helper.
   */
  async getAllPages<T>(
    path: string,
    params?: Record<string, string>,
    opts?: { maxItems?: number; initialOffset?: number },
  ): Promise<T[]> {
    const maxItems = opts?.maxItems ?? 500;
    const all: T[] = [];
    let offset = opts?.initialOffset ?? 0;
    // Loop bound is the server-reported total when present; otherwise walk
    // until a short page signals the end. maxItems caps iterations too.
    for (;;) {
      const pageParams = { ...params, offset: String(offset) };
      const page = await this.get<SpotifyPaged<T>>(path, pageParams);
      if (!page || !Array.isArray(page.items)) break;
      all.push(...page.items);
      if (all.length >= maxItems) return all.slice(0, maxItems);
      const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
      offset += limit;
      if (page.items.length === 0 || page.items.length < limit) break;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
    return all;
  }

  async post<T>(path: string, body?: unknown): Promise<T | null> {
    const url = this.buildUrl(path);
    return this.enqueue(async () => {
      const res = await this.rawRequest('POST', url, body);
      if (res.status === 204) return null;
      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        await res.text(); // drain body; endpoint returns non-JSON payload (e.g. queue ID as text/plain)
        return null;
      }
      return res.json() as Promise<T>;
    });
  }

  async put(path: string, body?: unknown): Promise<void> {
    const url = this.buildUrl(path);
    await this.enqueue(() => this.rawRequest('PUT', url, body));
  }

  /**
   * PUT with a pre-encoded body (e.g. base64 JPEG for playlist cover upload)
   * and an explicit Content-Type. Goes through the same rate-limited queue,
   * token-refresh and retry handling as put().
   */
  async putRaw(path: string, body: string, contentType = 'image/jpeg'): Promise<void> {
    const url = this.buildUrl(path);
    await this.enqueue(() => this.rawRequest('PUT', url, body, 0, contentType));
  }

  async delete(path: string, body?: unknown): Promise<void> {
    const url = this.buildUrl(path);
    await this.enqueue(() => this.rawRequest('DELETE', url, body));
  }
}
