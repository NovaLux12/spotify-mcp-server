import { readFile } from 'node:fs/promises';
import { loadTokens, saveTokens, TOKEN_FILE } from './auth.js';
import { LruTtlCache, shouldBypassCache, cacheKey } from './cache.js';
import { getConfig } from './config.js';
import { appendHistory } from './history.js';

const BASE_URL = 'https://api.spotify.com/v1';
import type { TokenData, SpotifyPaged } from './types/spotify.js';

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const requestTimeoutMs = getConfig().spotifyRequestTimeoutMs;
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(requestTimeoutMs) });
  } catch (err) {
    // We own the signal, so an abort here can only be our own timeout.
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new SpotifyApiError(
        408,
        `${init.method ?? 'GET'} ${url} timed out after ${Math.round(requestTimeoutMs / 1000)}s`,
      );
    }
    throw err;
  }
}

export class SpotifyApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    // Set only on rate-limit errors after retries were exhausted (#56) so
    // agents can make an informed wait-vs-abort decision.
    public readonly retryAfterSec?: number,
    // Spotify's error.reason when present (e.g. 'QUOTA_EXCEEDED' since the
    // July-2026 per-account quota change) so callers can distinguish quota
    // walls from momentary burst limits (#108).
    public readonly reason?: string,
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

export interface SpotifyClientOptions {
  /** Fetch-all cap override (#55); defaults to config fetchAllCap. */
  fetchAllCap?: number;
  /** TTL cache tuning (#54); omit for defaults. */
  cache?: { ttlMs?: number; maxEntries?: number };
  /** Disable the read cache entirely (tests, special flows). */
  disableCache?: boolean;
}

/** Per-page event emitted during getAllPages walks (#65). */
export interface PageProgress {
  /** Monotonic id of this walk; usable directly as an MCP progressToken. */
  walkId: number;
  /** 1-based page number. */
  page: number;
  /** Items accumulated so far. */
  fetched: number;
  /** Server-reported total when the page carried one. */
  total?: number;
}

export class SpotifyClient {
  private tokens: TokenData | null = null;
  private loadPromise: Promise<TokenData> | null = null;

  // Rate limiting
  private _lastRequestTime = 0;
  private _rateLimitUntil = 0;
  // Last throttling event this client observed (#56).
  private _lastThrottle: { retryAfterSec: number; waitedMs: number; at: number } | null = null;

  // Immutable-read TTL cache (#54) — null when disabled.
  readonly cache: LruTtlCache<unknown> | null;
  private readonly fetchAllCap: number;

  // Long-walk progress reporting (#65); index.ts installs a notifier that
  // forwards events as MCP progress notifications.
  private progressReporter: ((info: PageProgress) => void) | null = null;
  private walkCounter = 0;

  constructor(opts: SpotifyClientOptions = {}) {
    this.fetchAllCap = opts.fetchAllCap ?? getConfig().fetchAllCap;
    this.cache = opts.disableCache ? null : new LruTtlCache<unknown>(opts.cache);
  }

  /**
   * Install a callback invoked after every page of every getAllPages walk.
   * Callbacks must not throw meaningful errors — they are wrapped, but treat
   * them best-effort. Pass null to remove.
   */
  setProgressReporter(fn: ((info: PageProgress) => void) | null): void {
    this.progressReporter = fn;
  }

  /**
   * Human status line describing the most recent throttle, e.g.
   * "rate-limited by Spotify, waited 2s before retrying" — tools append it to
   * results so agents learn they were throttled (#56). Consumes the notice:
   * returns null once it has been taken or if no throttle happened since.
   */
  takeThrottleNotice(): string | null {
    const ev = this._lastThrottle;
    this._lastThrottle = null;
    if (!ev) return null;
    return `rate-limited by Spotify, waited ${Math.round(ev.waitedMs / 1000)}s before retrying`;
  }

  /** Structured rate-limit state for the spotify://me/rate-limit resource. */
  getRateLimitStatus(): {
    lastThrottleAt: number | null;
    retryAfterSec: number | null;
    cooldownRemainingMs: number;
  } {
    return {
      lastThrottleAt: this._lastThrottle?.at ?? null,
      retryAfterSec: this._lastThrottle?.retryAfterSec ?? null,
      cooldownRemainingMs: Math.max(0, this._rateLimitUntil - Date.now()),
    };
  }

  /**
   * Record a completed mutation in the opt-in history JSONL (#64). Only the
   * whitelisted fields survive serialization; failures are swallowed so a
   * history problem can never fail the underlying mutation.
   */
  private recordMutation(method: string, path: string, response: unknown): Promise<void> {
    const snapshotId =
      response !== null && typeof response === 'object' && 'snapshot_id' in response
        ? String((response as { snapshot_id: unknown }).snapshot_id)
        : undefined;
    return appendHistory({
      method,
      path,
      ...(snapshotId !== undefined ? { snapshot_id: snapshotId } : {}),
    }).catch(() => undefined);
  }

  /**
   * Post-mutation bookkeeping (#54/#64): drop every cached read (a mutation
   * may affect any previously cached object) and record the mutation in the
   * opt-in history JSONL. Never fails the underlying mutation.
   */
  private afterMutation(method: string, path: string, response: unknown): void {
    this.cache?.clear();
    void this.recordMutation(method, path, response);
  }

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

    // Cross-process race guard (#109): another spotify-mcp process may have
    // refreshed since we loaded our copy. If the on-disk token is fresher
    // than ours, adopt it and skip the network round-trip entirely.
    try {
      const stored = JSON.parse(await readFile(TOKEN_FILE, 'utf8')) as TokenData;
      if (Number.isFinite(stored.expires_at) && stored.expires_at > tokens.expires_at) {
        this.loadPromise = Promise.resolve(stored);
        this.tokens = stored;
        return;
      }
    } catch {
      // Missing/unreadable/corrupt file — fall through to a normal refresh.
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });

    let res: Response;
    try {
      res = await fetchWithTimeout('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      // Network failure or our own timeout. If the old access token is still
      // usable, keep it and let the current request proceed (#109); otherwise
      // there is nothing left to authenticate with.
      if (Date.now() < tokens.expires_at) return;
      throw new SpotifyApiError(503, 'Spotify token service temporarily unavailable');
    }

    if (!res.ok) {
      // Classify the failure before deciding what to surface (#109).
      let grantError: string | undefined;
      try {
        const errBody = (await res.json()) as { error?: unknown };
        if (typeof errBody?.error === 'string') grantError = errBody.error;
      } catch {
        // Non-JSON error body — treated as an unclassified failure below.
      }

      if (grantError === 'invalid_grant') {
        // Refresh token revoked/expired — only re-auth fixes this.
        throw new SpotifyApiError(res.status, 'Token refresh failed — re-run "spotify-mcp auth"');
      }

      // Transient outage (5xx) with a still-valid access token: ride it out.
      if (res.status >= 500 && Date.now() < tokens.expires_at) return;

      throw new SpotifyApiError(res.status, 'Spotify token service temporarily unavailable');
    }

    const data = await res.json() as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    // Guard against a malformed expires_in (#109): NaN/undefined would poison
    // expires_at forever, so treat it as already expired — the next request
    // will attempt another refresh instead of sending a dead token.
    const expiresIn = Number.isFinite(data.expires_in) ? data.expires_in : 0;

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + expiresIn * 1000,
    };

    await saveTokens(this.tokens);
  }

  /**
   * Two-lane request scheduler (#133): interactive requests ('normal') drain
   * before bulk-walk pages ('low'), so multi-minute library walks can no
   * longer starve quick reads. FIFO within a lane; pacing and rate-limit
   * waits apply to every task regardless of lane.
   */
  private _lanes: {
    normal: Array<{ run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
    low: Array<{ run: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  } = { normal: [], low: [] };
  private _draining = false;

  private enqueue<T>(fn: () => Promise<T>, priority: 'normal' | 'low' = 'normal'): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._lanes[priority].push({
        run: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this._drain();
    });
  }

  private _drain(): void {
    if (this._draining) return;
    this._draining = true;
    void (async () => {
      try {
        for (;;) {
          // Normal lane always wins; fall back to one low task at a time.
          const next = this._lanes.normal.shift() ?? this._lanes.low.shift();
          if (!next) break;
          const now = Date.now();
          const rateLimitWait = Math.max(0, this._rateLimitUntil - now);
          const gapWait = Math.max(0, this._lastRequestTime + 100 - now);
          const waitMs = Math.max(rateLimitWait, gapWait);
          if (waitMs > 0) await sleep(waitMs);
          this._lastRequestTime = Date.now();
          await next.run().then(next.resolve, next.reject);
        }
      } finally {
        this._draining = false;
        // Tasks enqueued during the final awaits restart the drain.
        if (this._lanes.normal.length > 0 || this._lanes.low.length > 0) this._drain();
      }
    })();
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

    // Rate limited — differentiate a quota wall from a burst limit (#108).
    if (res.status === 429 && retryCount === 0) {
      // Parse defensively: a garbage header must not yield NaN, which would
      // permanently poison _rateLimitUntil and disable backoff.
      const raw = Number.parseInt(res.headers.get('Retry-After') ?? '', 10);
      const retryAfter = Number.isFinite(raw) && raw >= 0 ? raw : 1;
      this._rateLimitUntil = Date.now() + retryAfter * 1000;

      // Read the body for error.reason (July-2026: 'QUOTA_EXCEEDED' when the
      // per-developer-account quota is exhausted — retrying sooner than
      // Retry-After is pointless, and sleeping inside the serialized queue
      // would head-of-line-block every other request for that duration).
      let reason: string | undefined;
      let spotifyMsg: string | undefined;
      try {
        const errBody = (await res.json()) as {
          error?: { message?: string; reason?: string };
        };
        reason = errBody.error?.reason;
        spotifyMsg = errBody.error?.message;
      } catch {
        // body wasn't JSON — header-only handling below still applies
      }

      const BURST_SLEEP_CAP_SEC = 10;
      if (reason === 'QUOTA_EXCEEDED') {
        throw new SpotifyApiError(
          429,
          `Spotify developer-account quota exceeded — no further requests until the quota window resets${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ''}${spotifyMsg ? ` — ${spotifyMsg}` : ''}`,
          retryAfter,
          reason,
        );
      }

      if (retryAfter > BURST_SLEEP_CAP_SEC) {
        // Too long to sleep inside the queue: fail fast with the wait time;
        // _rateLimitUntil already makes subsequent enqueued requests reject
        // until the window passes.
        throw new SpotifyApiError(
          429,
          `Rate limited — Retry-After ${retryAfter}s exceeds the in-queue wait cap (${BURST_SLEEP_CAP_SEC}s); retry later.`,
          retryAfter,
          reason,
        );
      }

      this._lastThrottle = { retryAfterSec: retryAfter, waitedMs: retryAfter * 1000, at: Date.now() };
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
      let reason: string | undefined;
      try {
        const errBody = (await res.json()) as {
          error?: { message?: string; reason?: string };
        };
        const spotifyMsg = errBody.error?.message;
        reason = errBody.error?.reason;
        if (spotifyMsg && spotifyMsg.trim().length > 0) {
          message = reason ? `${spotifyMsg} (reason: ${reason})` : spotifyMsg;
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

  async get<T>(path: string, params?: Record<string, string>, opts?: { priority?: 'normal' | 'low' }): Promise<T | null> {
    const url = this.buildUrl(path, params);
    // TTL cache for immutable catalog reads (#54): keyed on the API-relative
    // URL; volatile paths (/me/player*, /me/top*, recently-played) bypass.
    const relative = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const cacheable = this.cache !== null && !shouldBypassCache('GET', relative);
    const key = cacheable ? cacheKey('GET', relative) : '';
    if (cacheable) {
      const hit = this.cache!.get(key);
      if (hit !== undefined) return hit as T;
    }
    const result = await this.enqueue(
      async () => {
        const res = await this.rawRequest('GET', url);
        if (res.status === 204) return null;
        try {
          return (await res.json()) as T;
        } catch (err) {
          if (err instanceof SyntaxError) {
            // Body was not valid JSON. Best-effort drain so the connection
            // can be reused, then fail with an actionable error.
            await res.text().catch(() => undefined);
            throw new SpotifyApiError(res.status, `GET ${path} returned a non-JSON body`);
          }
          throw err;
        }
      },
      opts?.priority,
    );
    if (cacheable && result !== null) this.cache!.set(key, result);
    return result;
  }

  /**
   * Walk an offset-paginated list endpoint (responses shaped like
   * SpotifyPaged: items[], total, limit, offset, next) and accumulate every
   * item, going through the same rate-limited request queue as get().
   *
   * Stops when the cursor reaches the server-reported `total`; when a
   * response omits `total`, keeps walking until a short/empty page is
   * returned. `maxItems` caps collection either way, defaulting to the
   * configured fetch-all cap (SPOTIFY_MCP_FETCH_ALL_CAP, #55).
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
    const maxItems = opts?.maxItems ?? this.fetchAllCap;
    const all: T[] = [];
    let offset = opts?.initialOffset ?? 0;
    // Monotonic per-walk id; index.ts forwards it as the MCP progressToken.
    const walkId = ++this.walkCounter;
    let pageNumber = 0;
    // Loop bound is the server-reported total when present; otherwise walk
    // until a short page signals the end. maxItems caps iterations too.
    for (;;) {
      const pageParams = { ...params, offset: String(offset) };
      // #133: walk pages enqueue at LOW priority so interactive reads
      // always drain first.
      const page = await this.get<SpotifyPaged<T>>(path, pageParams, { priority: 'low' });
      if (!page || !Array.isArray(page.items)) break;
      all.push(...page.items);
      const reporter = this.progressReporter;
      if (reporter !== null) {
        try {
          reporter({
            walkId,
            page: ++pageNumber,
            fetched: all.length,
            ...(typeof page.total === 'number' ? { total: page.total } : {}),
          });
        } catch {
          // Progress is best-effort; a throwing reporter must never break a walk.
        }
      }
      if (all.length >= maxItems) return all.slice(0, maxItems);
      const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
      offset += limit;
      if (page.items.length === 0 || page.items.length < limit) break;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
    return all;
  }

  // Parse a successful response body as JSON, or null for 204 / non-JSON
  // payloads. Non-JSON bodies are drained so the connection can be reused.
  private async jsonOrNull<T>(res: Response): Promise<T | null> {
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      await res.text(); // endpoint returns a non-JSON payload (e.g. queue ID as text/plain)
      return null;
    }
    return (await res.json()) as T;
  }

  async post<T>(path: string, body?: unknown): Promise<T | null> {
    const url = this.buildUrl(path);
    const result = await this.enqueue(async () => {
      const res = await this.rawRequest('POST', url, body);
      return this.jsonOrNull<T>(res);
    });
    this.afterMutation('POST', path, result);
    return result;
  }

  async put<T>(path: string, body?: unknown): Promise<T | null> {
    const url = this.buildUrl(path);
    const result = await this.enqueue(async () => {
      const res = await this.rawRequest('PUT', url, body);
      return this.jsonOrNull<T>(res);
    });
    this.afterMutation('PUT', path, result);
    return result;
  }

  /**
   * PUT a raw string body (used for cover image uploads) with an explicit
   * Content-Type. Goes through the same rate-limited queue,
   * token-refresh and retry handling as put().
   */
  async putRaw(path: string, body: string, contentType = 'image/jpeg'): Promise<void> {
    const url = this.buildUrl(path);
    await this.enqueue(() => this.rawRequest('PUT', url, body, 0, contentType));
    this.afterMutation('PUT', path, null);
  }

  async delete<T>(path: string, body?: unknown): Promise<T | null> {
    const url = this.buildUrl(path);
    const result = await this.enqueue(async () => {
      const res = await this.rawRequest('DELETE', url, body);
      return this.jsonOrNull<T>(res);
    });
    this.afterMutation('DELETE', path, result);
    return result;
  }
}
