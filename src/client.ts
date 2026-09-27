import { loadTokens, saveTokens, getTokenFilePath } from './auth.js';
import {
  LruTtlCache,
  ValidatorStore,
  shouldBypassCache,
  cacheKey,
  invalidationPlan,
  type InvalidationPlan,
} from './cache.js';
import {
  armPendingMarker,
  cachePendingPath,
  cachePersistEnabled,
  cachePersistPath,
  consumePendingMarker,
  isPersistableKey,
  loadPersistedCache,
  savePersistedCache,
  savePersistedCacheSync,
  type CachePersistOptions,
  type CachePersistStats,
  type PersistedEntry,
} from './cachepersist.js';
import { getConfig } from './config.js';
import { ownStoreRoots, readLocalFile } from './paths.js';
import { appendHistory, currentToolName } from './history.js';
import { currentRequestSignal } from './cancellation.js';
import type { MutationRecord } from './history.js';

const BASE_URL = 'https://api.spotify.com/v1';

/**
 * How long a burst of cache writes coalesces into one file write (#893).
 * Long enough that a paged walk costs one write rather than one per page,
 * short enough that a session that ends shortly after a read still persists.
 */
const CACHE_PERSIST_DEBOUNCE_MS = 250;

/**
 * How many recent invalidations the read/write race guard can reason about
 * (#1249 review). A read that raced an invalidation older than this window is
 * treated as invalidated rather than reasoned about, so the bound trades a
 * possible lost cache fill for never serving a stale body.
 */
const INVALIDATION_LOG_LIMIT = 64;

/** One recorded invalidation: which epoch, and exactly what it dropped. */
interface InvalidationEvent {
  readonly epoch: number;
  /** A full clear — exempts no key. */
  readonly all: boolean;
  readonly payload: readonly string[];
  readonly validators: readonly string[];
}
import type { TokenData, SpotifyPaged } from './types/spotify.js';

/**
 * One fetch wrapper with the spotifyRequestTimeoutMs cap, exported so non-Spotify
 * callers (cover image fetch from a CDN, etc.) can share the same timeout and
 * translate a stall into a typed SpotifyApiError (#880).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  const requestTimeoutMs = getConfig().spotifyRequestTimeoutMs;
  // A caller-supplied signal (#676) and our own deadline are INDEPENDENT
  // aborts, so they are combined rather than one overwriting the other. The
  // previous `{ ...init, signal: AbortSignal.timeout(...) }` could only ever
  // honour the timeout: a `signal` passed in `init` was silently discarded, so
  // a cancelled MCP request kept its socket open to the deadline.
  //
  // `AbortSignal.any` is used rather than a manual listener so the combined
  // signal is not retained by either source: an SDK request signal outlives
  // every request it aborts, and a listener left on it would accumulate one
  // entry per Spotify call for the life of the session.
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
  const effective = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
  try {
    return await fetch(url, { ...init, signal: effective });
  } catch (err) {
    // The two abort causes must stay distinguishable. A timeout means "Spotify
    // is slow, retry shortly" (408). A cancellation means the CALLER gave up —
    // telling it to retry would spend the quota it just decided to stop
    // spending — so it gets its own 499. The check is on the caller's signal
    // rather than on the error's name because `AbortSignal.any` propagates
    // whichever source fired, and a caller aborting with a custom reason
    // rejects with that reason rather than an `AbortError`.
    if (signal?.aborted) {
      throw new SpotifyApiError(CANCELLED_STATUS, cancellationMessage(init.method, url));
    }
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new SpotifyApiError(
        408,
        `${init.method ?? 'GET'} ${url} timed out after ${Math.round(requestTimeoutMs / 1000)}s`,
      );
    }
    throw err;
  }
}

/**
 * Status for a caller-cancelled request (#676).
 *
 * 499 is nginx's "client closed request", chosen because it is outside every
 * band the Spotify error mapping already owns: it must not read as 401
 * (re-auth), 403 (Premium/scope), 408 (retry shortly) or 429 (wait for the
 * window). A host told "408, retry shortly" about a call it deliberately
 * abandoned would re-issue exactly the quota spend the caller cancelled.
 */
export const CANCELLED_STATUS = 499;

/** Reason tag so a caller can classify without parsing the message. */
export const CANCELLED_REASON = 'CANCELLED';

function cancellationMessage(method: string | undefined, target: string | undefined): string {
  // The queue has no method or path to name: a task is dropped at the lane,
  // where the only thing known about it is that its caller left. Saying so
  // plainly beats printing "GET undefined".
  if (target === undefined) {
    return `${method ?? 'Request'} cancelled by the caller before it was sent`;
  }
  return `${method ?? 'GET'} ${target} cancelled by the caller`;
}

/**
 * The error a cancelled call raises. Constructed at every place that refuses to
 * keep working, so a cancellation reads identically whether it was caught
 * between pages or thrown from an in-flight fetch — a caller (or a host
 * reading the tool result) must not have to tell those apart.
 */
export function cancelledError(method: string | undefined, target: string | undefined): SpotifyApiError {
  return new SpotifyApiError(
    CANCELLED_STATUS,
    cancellationMessage(method, target),
    undefined,
    CANCELLED_REASON,
  );
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

/**
 * Minimum gap between request STARTS, enforced process-wide by the funnel's
 * shared start gate (#892). Unchanged from the serial queue: pacing is a
 * property of the process, not of a call, so concurrent requests RESERVE slots
 * on one counter instead of each reading a timestamp another task is about to
 * overwrite.
 */
const REQUEST_START_GAP_MS = 100;

/**
 * Internal control-flow signal: a 429 worth retrying, raised by `rawRequest`
 * and caught by the scheduler, which re-queues the attempt instead of letting
 * the task sleep in place (#892).
 *
 * The retry used to be `await sleep(retryAfter * 1000)` inside the task body.
 * That put a process-wide cooldown inside a single request: the sleeping task
 * held the funnel while every other call — cheap reads, token refresh, other
 * composites — queued behind it, and N throttled calls paid N waits for one
 * window. Re-queueing makes the wait the shared gate's job instead, so a burst
 * pays one window for the whole process.
 *
 * It is deliberately NOT a `SpotifyApiError` and carries no continuation. The
 * scheduler re-runs the whole task with one more attempt, so the body that
 * parses the response is still the body that runs: a continuation holding just
 * the inner `rawRequest` would re-issue the HTTP call and drop its result on
 * the floor, handing a `Response` back where the caller expects parsed JSON.
 */
class ThrottleRetry extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`rate limited; retry after ${retryAfterSec}s`);
    this.name = 'ThrottleRetry';
  }
}

/**
 * Longest single wait the client will hold the serialized request queue for,
 * whoever asked for it: a 429 `Retry-After` (#108) or a 5xx backoff (#675).
 * Past this the caller gets the error with the wait attached rather than a
 * queue that holds every other request hostage.
 */
const RETRY_SLEEP_CAP_SEC = 10;

/** Wait used when a `Retry-After` header is absent or unparsable (#20). */
const RETRY_AFTER_FALLBACK_SEC = 1;

/**
 * Total dispatches one logical request may consume, shared by the 401-refresh,
 * the 429 backoff (#671), the 5xx backoff and transport-error retries (#675).
 * Bounded on purpose: an unbounded backoff against a permanently unhealthy
 * Spotify is its own outage, and a tight retry loop earns a rate limit.
 */
const MAX_ATTEMPTS = 3;

/** First-retry backoff base and its uniform jitter width: 250ms, then 500ms. */
const RETRY_BACKOFF_BASE_MS = 250;
const RETRY_BACKOFF_JITTER_MS = 250;

/**
 * Gateway/upstream failures — statuses where the request was rejected rather
 * than applied, so a re-send is safe even for a mutation. 500 is deliberately
 * absent: it is Spotify's own logic failing, and re-sending does not help.
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * Verbs whose re-send cannot double-apply a change (RFC 9110 §9.2.2). Only
 * these may be re-sent after a *thrown* transport error, where we never
 * received an answer and so never learned whether the request landed.
 */
const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'HEAD',
  'PUT',
  'DELETE',
  'OPTIONS',
]);

/**
 * Seconds to wait before re-sending, parsed from a `Retry-After` header.
 *
 * RFC 9110 §10.2.3 defines two forms and the previous `Number.parseInt` read
 * only one: delta-seconds parsed, and the HTTP-date form became NaN and fell
 * through to the 1 s floor. A server asking for minutes was therefore retried
 * after one second — which earns another 429, and with N spotify-mcp processes
 * sharing one developer account produces a synchronized retry wave.
 *
 * A past HTTP-date means "retry now", not "wait backwards". An absent or
 * unparsable header keeps the pre-existing 1 s floor, so garbage still cannot
 * poison the cooldown with NaN (#20). Note `Date.parse` happily reads a bare
 * signed number as a year (`Date.parse('-5')` is a date in 2001), so the
 * HTTP-date branch requires a letter — every legal HTTP-date form has one, and
 * without the guard `-5` would silently become a 0 s wait.
 */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number {
  const raw = (header ?? '').trim();
  if (raw.length === 0) return RETRY_AFTER_FALLBACK_SEC;
  // delta-seconds. Fractional values are accepted too: a truncating parseInt
  // would round "0.5" to a 0 s wait.
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : RETRY_AFTER_FALLBACK_SEC;
  }
  if (!/[A-Za-z]/.test(raw)) return RETRY_AFTER_FALLBACK_SEC;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return RETRY_AFTER_FALLBACK_SEC;
  return Math.max(0, (at - now) / 1000);
}

/**
 * A transport failure (DNS, connection reset, socket hang-up) has no HTTP
 * status, but it must still reach callers as a typed `SpotifyApiError`: a raw
 * `TypeError` falls through the tool error boundary to `internal`, which
 * advises a blind re-run of the whole tool — precisely the retry that would
 * double-apply a mutation. 503 is the status the boundary already maps to
 * `unavailable`, which is what a network blip actually is.
 *
 * A synthesized 408 timeout is passed through unchanged: it is already typed,
 * it names the method, URL and timeout, and downgrading it to 503 would
 * discard that.
 */
function transportFailure(method: string, url: string, err: unknown): SpotifyApiError {
  if (err instanceof SpotifyApiError) return err;
  const cause = err instanceof Error ? err.message : String(err);
  return new SpotifyApiError(503, `${method} ${url} failed: ${cause}`);
}

// Player-namespace 404s are not missing objects: the /me/player/* endpoints
// answer 404 with "Player command failed: No active device found" whenever
// nothing anywhere is playing. That is the most common playback failure, and
// the generic 404 line gives the agent no diagnosis and no next step (#849).
const NO_ACTIVE_DEVICE_MESSAGE =
  'No active Spotify device — playback control needs a device that is ' +
  'currently active. Next step: start playback in the Spotify app (phone, ' +
  'desktop, or smart TV), then run device_health to confirm the active ' +
  'device; if the device is known but not active, select it in the app, or ' +
  'pass its device_id to target it directly.';

/**
 * The no-active-device message, naming the device_id the call actually asked
 * for when one was supplied (#849).
 *
 * A stale `device_id` is the other way to land here, and it is invisible to
 * the agent if the message does not say which id was rejected: it reads
 * "start playback in the app" and re-sends the same dead id. The id is read
 * from the request URL, so it is the value Spotify rejected — not a guess.
 * Absent or unparseable ⇒ no id clause; unknown stays unknown.
 */
function noActiveDeviceMessage(url: string): string {
  let deviceId: string | null = null;
  try {
    const raw = new URL(url).searchParams.get('device_id');
    if (raw && raw.trim().length > 0) deviceId = raw;
  } catch {
    deviceId = null;
  }
  if (deviceId === null) return NO_ACTIVE_DEVICE_MESSAGE;
  return (
    `${NO_ACTIVE_DEVICE_MESSAGE} Spotify rejected device_id "${deviceId}": ` +
    'that id is not an available device for this account (it may be stale, ' +
    'from another account, or no longer reachable). Run device_health to list ' +
    `the current device ids, then re-run with one of those (or omit device_id ` +
    'to target the active device).'
  );
}

/**
 * True when Spotify's own 404 body describes a player/device problem rather
 * than a missing resource. Deliberately narrow: a plain 404 ("Not found." for
 * a playlist) must keep the generic not-found mapping.
 */
function isNoActiveDevice404(message: string | undefined): boolean {
  if (!message) return false;
  if (/no active device/i.test(message)) return true;
  // Some player errors omit the word "active" but still name the device, e.g.
  // "Player command failed: Device not found". A "Player command failed"
  // body WITHOUT a device mention (e.g. a restriction failure) is left alone.
  return /player command failed/i.test(message) && /\bdevice/i.test(message);
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

interface SpotifyClientOptions {
  /** Fetch-all cap override (#55); defaults to config fetchAllCap. */
  fetchAllCap?: number;
  /**
   * In-flight request ceiling override (#892); defaults to
   * SPOTIFY_MCP_MAX_CONCURRENCY. `1` is the strictly serial funnel.
   */
  maxConcurrency?: number;
  /** TTL cache tuning (#54); omit for defaults. */
  cache?: { ttlMs?: number; maxEntries?: number };
  /**
   * Cross-process cache persistence (#893). Only read when
   * `SPOTIFY_MCP_CACHE_PERSIST` opts in; `file` overrides the path and
   * `maxBytes` the cap, which is how tests keep every write under a temp dir.
   */
  cachePersist?: { file?: string; maxBytes?: number };
  /**
   * How long a stored ETag stays usable as an `If-None-Match` validator
   * (#601); omit for the default window. Ignored when `disableCache` is set.
   */
  validatorTtlMs?: number;
  /** Disable the read cache entirely (tests, special flows). */
  disableCache?: boolean;
  /**
   * The token file this client loads, refreshes and persists (#609). Defaults
   * to `getTokenFilePath()` — argv profile included. Override only where a
   * test needs a fixture; a client pointed at one account's file while the
   * process runs as another is exactly the split this option exists to make
   * explicit and impossible to do by accident.
   */
  tokenFile?: string;
  /**
   * Jitter source for the 5xx/transport backoff (#675). Defaults to
   * `Math.random`; injectable so a test can pin the sequence and assert the
   * jitter is a real spread rather than an accident of the base doubling.
   */
  random?: () => number;
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

/** Per-call options for {@link SpotifyClient.getAllPages} and its truncation variant. */
export interface GetAllPagesOptions {
  /** Hard cap on accumulated rows; defaults to the configured fetch-all cap. */
  maxItems?: number;
  /** Seed the offset cursor so a caller resuming mid-list does not restart at 0. */
  initialOffset?: number;
  /**
   * Called once per page with the same {@link PageProgress} the global
   * reporter receives, so the CALLER can count the requests its own walk
   * spent (#902).
   *
   * It is a per-call argument rather than client state on purpose: the SDK
   * dispatches `tools/call` without awaiting, so concurrent walks share one
   * client and a stored counter would report whichever walk finished last —
   * the same reasoning that keeps the truncation verdict off the client in
   * #864. A tool reporting `requests_read` counts pages here rather than
   * diffing `requestsTotal`, which also counts every other call on the client.
   *
   * Best-effort: a throwing hook is swallowed and cannot break the walk.
   */
  onPage?: (info: PageProgress) => void;
  /**
   * Abort signal for this walk (#676). Checked BEFORE each page request, so a
   * cancellation costs at most the one page already in flight. Omitting it
   * falls back to the ambient `tools/call` request signal — see
   * {@link GetOptions.signal}.
   */
  signal?: AbortSignal;
}

/**
 * Lane selection for the two-lane scheduler (#133): the oldest LOW task
 * waiting >= agingMs is promoted ahead of queued NORMAL tasks so continuous
 * interactive traffic cannot starve background walks. Pure so tests can pin
 * the promotion boundary without timers.
 */
interface LaneTask {
  /**
   * The queued work. It receives the attempt count so the retry budget is
   * owned by the scheduler rather than buried in a recursion inside the
   * request body — that is what lets a throttled attempt re-enter the queue
   * as a whole task instead of as a bare response.
   */
  run: (attempts: number) => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  enqueuedAt: number;
  /** Attempts already spent; 0 on a first submission. */
  attempts: number;
  /**
   * The lane this task was enqueued on (#892). A throttled attempt is
   * re-queued onto the same lane, so a retry cannot quietly promote a bulk
   * walk page ahead of the interactive reads that were queued before it.
   */
  priority: 'normal' | 'low';
  /**
   * The caller's cancellation signal, captured at enqueue time (#676). Not
   * read from ambient context at drain time: the drain runs under the
   * scheduler's context, so a task would be judged against whichever request
   * happened to wake it rather than the one that asked for the work.
   */
  signal?: AbortSignal;
}

export function selectNextLaneTask(
  normal: LaneTask[],
  low: LaneTask[],
  now: number,
  agingMs: number,
): LaneTask | undefined {
  if (low.length > 0 && now - low[0].enqueuedAt >= agingMs) {
    return low.shift()!;
  }
  return normal.shift() ?? low.shift();
}

/**
 * Structured rate-limit + quota-usage state (#56/#59/#904). The first three
 * fields predate #904 and are unchanged; the request counters are additive.
 */
interface RateLimitStatus {
  lastThrottleAt: number | null;
  retryAfterSec: number | null;
  cooldownRemainingMs: number;
  /** Cumulative API requests issued through the drain queue this process. */
  requestsTotal: number;
  /** Requests issued in the trailing 60s (rolling window). */
  requestsLastMinute: number;
  /** Requests issued in the trailing 60min (rolling window). */
  requestsLastHour: number;
  /**
   * Read-cache pressure (#894). Optional because a client can be constructed
   * with the cache disabled or with a stub that has no cache at all; the
   * fields are present whenever one exists, so an operator can tell cache
   * pressure from the process baseline instead of guessing.
   */
  cacheEntries?: number;
  cacheBytes?: number;
  cacheMaxBytes?: number;
  cacheSkippedOversize?: number;
  /** True when `SPOTIFY_MCP_CACHE_PERSIST` is on (#893). Absent when it is not. */
  cachePersist?: boolean;
  /** Entries restored from the persisted file at startup (#893). */
  cacheRestored?: number;
  /** Persist failures and allowlist refusals, so a dead cache is visible (#893). */
  cachePersistFailed?: number;
  cachePersistRefused?: number;
  /** Entries dropped for exceeding the persisted byte cap (#1249). */
  cachePersistOversize?: number;
  /**
   * Entries a PREVIOUS process had pending when it was killed without running
   * any JavaScript — SIGKILL, an OOM-kill, a supervisor hard-stop, a power loss
   * (#1279). Zero when no such death was detected.
   *
   * Reported by the process AFTER the one that lost them, from a marker file
   * that the kill could not remove. It is a count of writes this process knows
   * it did not make; it is NOT a repair, and the entries are gone.
   */
  cachePersistLost?: number;
  /** Requests currently open in the funnel (#892). */
  inFlight: number;
  /** The funnel's concurrency ceiling for this process (#892). */
  maxConcurrency: number;
  /** High-water mark of `inFlight` (#892) — the concurrency actually reached. */
  peakInFlight: number;
  /**
   * Consecutive 429s observed; reset by any request that was not throttled
   * (#892). At or above the trip count the funnel fails new work fast rather
   * than queueing it into the same wall.
   */
  throttleStreak: number;
}

/**
 * Per-`get` options. `onNotModified` fires exactly when the origin answered
 * 304 and the returned payload is the locally stored one the ETag
 * identifies — the signal a watch loop branches on (#601). It is a callback
 * rather than a field on the client because concurrent tool calls interleave:
 * a shared "last read was a 304" flag would be attributable to the wrong call.
 */
export interface GetOptions {
  priority?: 'normal' | 'low';
  onNotModified?: () => void;
  /**
   * Abort signal for this read (#676). When omitted, the ambient
   * `tools/call` request signal is used, so a handler that never mentions
   * cancellation still stops when its host cancels the request. Supply one
   * explicitly to override that — the two never combine, because a direct
   * caller has no request signal and a tool handler has no business inventing
   * its own.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Token-endpoint failure classification (#677)
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://accounts.spotify.com/api/token';

/**
 * What a token-endpoint failure actually was, as far as the response (or the
 * thrown error) says. Every value is evidence, never a guess at the nearest
 * plausible cause:
 *
 *   invalid_client     — the JSON body carried `error: "invalid_client"`, so
 *                        Spotify refused the configured app id.
 *   invalid_grant      — the JSON body carried `error: "invalid_grant"`, so the
 *                        stored refresh token is dead (#109).
 *   request_rejected   — the body carried a named `error` code that is neither
 *                        of the two with a known fix. The code is reported
 *                        verbatim instead of being folded into one of them.
 *   rate_limited       — HTTP 429, with `Retry-After` when the header was sent.
 *   server_error       — HTTP 5xx, i.e. a fault on Spotify's side.
 *   network_unreachable — no HTTP response arrived at all, so it is classified
 *                        from the thrown error's own shape (DNS, refused,
 *                        reset, our own abort) and never from a body.
 *   unclassified       — a failure with no evidence that names a cause. Said
 *                        to be unknown on purpose: an unclassified error is a
 *                        true statement, and a misclassified one sends the
 *                        operator after a cause the response never mentioned.
 */
type TokenFailureCategory =
  | 'invalid_client'
  | 'invalid_grant'
  | 'request_rejected'
  | 'rate_limited'
  | 'server_error'
  | 'network_unreachable'
  | 'unclassified';

/**
 * Reason code per category. These ride the thrown `SpotifyApiError` as its
 * `reason`, so the tool error boundary keeps the class instead of re-deriving
 * it from a status that several very different failures share.
 */
const TOKEN_FAILURE_REASONS: Record<TokenFailureCategory, string> = {
  invalid_client: 'TOKEN_INVALID_CLIENT',
  invalid_grant: 'TOKEN_INVALID_GRANT',
  request_rejected: 'TOKEN_REQUEST_REJECTED',
  rate_limited: 'TOKEN_RATE_LIMITED',
  server_error: 'TOKEN_SERVER_ERROR',
  network_unreachable: 'TOKEN_NETWORK_UNREACHABLE',
  unclassified: 'TOKEN_UNCLASSIFIED',
};

/**
 * A 2xx whose body will not parse is its own case rather than a member of
 * `unclassified`: Spotify did answer, it answered with something unreadable,
 * and that is a different thing to tell an operator than "no evidence".
 */
const TOKEN_UNREADABLE_RESPONSE = 'TOKEN_UNREADABLE_RESPONSE';

const TOKEN_FAILURE_REASON_SET: ReadonlySet<string> = new Set([
  ...Object.values(TOKEN_FAILURE_REASONS),
  TOKEN_UNREADABLE_RESPONSE,
]);

/** True when a `SpotifyApiError.reason` was minted by this classifier (#677). */
export function isTokenFailureReason(reason: unknown): reason is string {
  return typeof reason === 'string' && TOKEN_FAILURE_REASON_SET.has(reason);
}

interface TokenFailure {
  category: TokenFailureCategory;
  reason: string;
  /**
   * Status to surface, chosen for what it means to the *caller's* request
   * rather than what the token endpoint said: a refresh failure is never a bad
   * tool argument (#1007), so nothing here is a 4xx validation status.
   */
  status: number;
  /** Evidence-based, and naming the token file a multi-profile install needs. */
  message: string;
  retryAfterSec?: number;
  /**
   * True when a still-valid access token makes it honest to continue instead
   * of failing the call. Only failures that are themselves transient get it —
   * riding out a refused client id would hide the misconfiguration until it
   * became unauthenticated.
   */
  rideOut: boolean;
  /**
   * True when a bounded retry of the refresh itself is worth the backoff.
   * Deliberately excludes a 429 (the wait belongs in the thrown error, not in
   * a serialized queue) and our own abort (already a full timeout wait, so
   * three attempts would hold the queue for three timeouts).
   */
  retry: boolean;
}

/** Append the token file to a failure message: a multi-profile install cannot
 *  otherwise tell which of several token files is the broken one (#677).
 *
 *  The path is the CALLER's, resolved from the argv profile (#609). It used to
 *  be a module-level env-only constant, so a `--profile work` failure pointed
 *  the operator at `tokens.json` — the file that was not involved. */
function withTokenFile(message: string, tokenFile: string): string {
  return `${message} (token file: ${tokenFile})`;
}

/**
 * The token endpoint's machine-readable grant code, read from the body shape
 * RFC 6749 §5.2 actually uses: `{"error":"invalid_grant"}` — a *string*.
 * The Web API's own `{"error":{"message":…}}` object is deliberately not
 * accepted, because `error.message` is prose about an API call and reading it
 * as a grant code would invent a classification.
 */
function readGrantError(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const { error } = body as { error?: unknown };
  if (typeof error !== 'string') return undefined;
  const trimmed = error.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** One line, bounded: a cause string reaches both a tool message and a log. */
function oneLine(value: string, max = 160): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Classify a non-ok token response from the two things it actually carries:
 * the status, and the body's `error` code. Never both from one and neither
 * from the other.
 */
function classifyTokenResponse(
  status: number,
  retryAfterHeader: string | null,
  body: unknown,
  bodyReadable: boolean,
  tokenFile: string,
): TokenFailure {
  const reason = (category: TokenFailureCategory): string => TOKEN_FAILURE_REASONS[category];

  if (status === 429) {
    const retryAfterSec = parseRetryAfter(retryAfterHeader);
    return {
      category: 'rate_limited',
      reason: reason('rate_limited'),
      // 429 so the wait survives the boundary rather than being flattened into
      // a generic outage, which is what made an agent retry immediately and
      // prolong the limit it was already inside (#503).
      status: 429,
      retryAfterSec,
      rideOut: false,
      retry: false,
      message: withTokenFile(
        `Token refresh was rate limited by the token endpoint (HTTP 429) — retry in ${retryAfterSec}s ` +
          // The header is echoed as sent, one-lined and bounded: a value this
          // server did not verify is still quoted, but it cannot inject a line
          // break into a message that reaches a log and an agent.
          `(Retry-After: ${retryAfterHeader === null ? `absent, so the ${RETRY_AFTER_FALLBACK_SEC}s floor applies` : oneLine(retryAfterHeader, 40)})`,
        tokenFile,
      ),
    };
  }

  if (status >= 500) {
    return {
      category: 'server_error',
      reason: reason('server_error'),
      // 503 because it *is* an availability failure — and it is the only
      // token failure entitled to that wording, since it is the only one whose
      // status is a genuine 5xx.
      status: 503,
      rideOut: true,
      retry: true,
      message: withTokenFile(
        `Spotify's token endpoint returned HTTP ${status}` +
          `${retryAfterHeader ? ` with Retry-After: ${oneLine(retryAfterHeader, 40)}` : ''} ` +
          '— a server-side failure at Spotify, not a local configuration fault',
        tokenFile,
      ),
    };
  }

  const grantError = readGrantError(body);

  if (grantError === 'invalid_grant') {
    return {
      category: 'invalid_grant',
      reason: reason('invalid_grant'),
      // 401, not the token endpoint's own 400: the request this refresh was
      // serving carried no bad arguments, and publicFailure maps 400 to
      // "invalid arguments; pass values that match the tool schema" (#1007).
      status: 401,
      rideOut: false,
      retry: false,
      message: withTokenFile(
        'Token refresh failed — re-run "spotify-mcp auth" (refresh token rejected: invalid_grant)',
        tokenFile,
      ),
    };
  }

  if (grantError === 'invalid_client') {
    return {
      category: 'invalid_client',
      reason: reason('invalid_client'),
      status: 401,
      rideOut: false,
      retry: false,
      // The most common non-recoverable refresh failure on a self-hosted
      // install: a recreated dashboard app, or a rotated id. Reported as a
      // retryable outage it sent the agent into a retry loop instead of
      // telling the operator which setting is wrong (#677).
      message: withTokenFile(
        'Token refresh rejected — SPOTIFY_CLIENT_ID was refused by Spotify (invalid_client); '
          + 'set it to the Client ID of your app in the Spotify Developer Dashboard and re-run '
          + '"spotify-mcp auth" (PKCE uses no client secret)',
        tokenFile,
      ),
    };
  }

  if (grantError !== undefined) {
    // Named, but not one this server has a fix for. The code is reported
    // verbatim rather than mapped onto the closest category it resembles:
    // guessing here is what produced the outage-shaped message this replaces.
    return {
      category: 'request_rejected',
      reason: reason('request_rejected'),
      status: 401,
      rideOut: false,
      retry: false,
      message: withTokenFile(
        `Token refresh rejected by the token endpoint with error "${oneLine(grantError, 60)}" — this server has `
          + 'no fix for that code and asserts no cause; read the code above',
        tokenFile,
      ),
    };
  }

  const bodyDesc = !bodyReadable
    ? 'a body that is not JSON'
    : 'a JSON body with no string "error" field';
  return {
    category: 'unclassified',
    reason: reason('unclassified'),
    // 401 rather than the endpoint's own 4xx: the honest statement is that
    // this call could not authenticate, and mapping an unreadable 4xx onto
    // `unavailable` would be the outage claim this issue exists to remove.
    status: 401,
    rideOut: false,
    retry: false,
    message: withTokenFile(
      `Token refresh failed with HTTP ${status} and ${bodyDesc} — the cause could not be classified `
        + 'from the response',
      tokenFile,
    ),
  };
}

/**
 * The first `code` reachable from a thrown transport error, walking `cause`
 * (undici nests the real syscall failure under `Error: fetch failed`) and
 * `errors` (an AggregateError over parallel A/AAAA lookups). Falls back to the
 * error's own message, and to a literal "no cause reported" rather than to a
 * plausible-sounding cause the error never gave.
 */
function networkCauseLabel(err: unknown): string {
  const seen = new Set<unknown>();
  const queue: unknown[] = [err];
  while (queue.length > 0 && seen.size < 8) {
    const current = queue.shift();
    if (current === null || current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (typeof current !== 'object') break;
    const bag = current as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof bag.code === 'string' && bag.code.length > 0) return oneLine(bag.code, 60);
    if (bag.cause !== undefined) queue.push(bag.cause);
    if (Array.isArray(bag.errors)) queue.push(...bag.errors.slice(0, 4));
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 0 ? oneLine(message, 120) : 'no cause reported';
}

/**
 * Classify a refresh that never received an HTTP response. There is no body to
 * read here, so the class comes from the shape of the thrown error alone and
 * is deliberately kept separate from every response-borne class above.
 */
function classifyTokenTransportFailure(err: unknown, tokenFile: string): TokenFailure {
  // fetchWithTimeout owns the abort signal, so an abort arriving from it can
  // only be the timeout it armed — that is a fact about the call, not a guess.
  const isOurTimeout = err instanceof SpotifyApiError && err.status === 408;
  const timeoutSec = Math.round(getConfig().spotifyRequestTimeoutMs / 1000);
  return {
    category: 'network_unreachable',
    reason: TOKEN_FAILURE_REASONS.network_unreachable,
    // 408 for our own abort (the boundary already reads that as a timeout);
    // 503 for a transport failure, matching transportFailure above.
    status: isOurTimeout ? 408 : 503,
    rideOut: true,
    retry: !isOurTimeout,
    message: withTokenFile(
      isOurTimeout
        ? `Token refresh timed out after ${timeoutSec}s without an answer from accounts.spotify.com — ` +
          'no HTTP response was received (raise SPOTIFY_REQUEST_TIMEOUT_MS if this is a slow link)'
        : `Token refresh could not reach accounts.spotify.com — no HTTP response was received ` +
          `(${networkCauseLabel(err)}); this is a local network, DNS or TLS failure, not a Spotify outage`,
      tokenFile,
    ),
  };
}

/**
 * Owns the persisted half of the read cache (#893): restores once, and
 * debounces saves so a burst of reads costs one write.
 *
 * Deliberately separate from {@link SpotifyClient} so the persistence policy —
 * which keys may be written, what happens to a corrupt file — is testable
 * without a client, a token file, or a network stub.
 */
class CachePersistController {
  private restoredCount = 0;
  private failed = 0;
  private refused = 0;
  private oversize = 0;
  /**
   * Entries a PREVIOUS process had pending when it died without running any
   * JavaScript (#1279). Zero means no such death was detected.
   *
   * Distinct from `failed` on purpose: `failed` is a write this process
   * attempted and watched fail, which it can describe exactly. This is a write
   * that never happened, reported by the next process on the only evidence that
   * survives a SIGKILL — a marker file. Conflating the two would let a silent
   * hard kill read as a healthy session.
   */
  private lostLastSession = 0;
  private loaded: Promise<void> | null = null;
  private pendingSave: ReturnType<typeof setTimeout> | null = null;
  /**
   * The snapshot a pending save would write, or null when nothing is queued.
   *
   * Held as state rather than closed over by the timer callback so a flush can
   * perform exactly the save the timer was going to perform (#1266).
   */
  private pendingEntries: PersistedEntry[] | null = null;
  /** The `.pending` marker path beside this controller's cache file (#1279). */
  private readonly pendingMarker: string;

  constructor(
    private readonly file: string,
    private readonly opts: { file?: string; maxBytes?: number } | undefined,
    private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {
    // Derived from the SAME cache path the controller already holds, so the
    // marker inherits the profile suffix and a second profile resolution —
    // the thing that would let two accounts share one marker — never happens.
    this.pendingMarker = cachePendingPath(undefined, { ...opts, file });
  }

  /** What the persistence layer did, for `spotify_doctor`. */
  stats(): { restored: number; failed: number; refused: number; oversize: number; lost: number } {
    return {
      restored: this.restoredCount,
      failed: this.failed,
      refused: this.refused,
      oversize: this.oversize,
      lost: this.lostLastSession,
    };
  }

  /**
   * Restore persisted entries into `cache`, once.
   *
   * A load failure is counted and not rethrown HERE — a broken sidecar is an
   * optimisation that cannot be allowed to stop the server booting — but it is
   * visible through {@link stats} and `spotify_doctor`, so "the persisted cache
   * is not loading" is reportable rather than silent. `loadSidecar` preserves
   * the corrupt bytes, so attempting the load destroys nothing.
   */
  load(cache: LruTtlCache<unknown> | null): Promise<void> {
    if (this.loaded) return this.loaded;
    if (!cache) return Promise.resolve();
    // Report a previous session's hard kill BEFORE the load resolves, and
    // outside the promise chain: a corrupt cache file must not be able to
    // swallow the news that entries were lost, and a failed load is exactly
    // when losing them matters most.
    const lost = consumePendingMarker({ ...this.opts, file: this.file });
    if (lost !== null) this.lostLastSession = lost;
    this.loaded = loadPersistedCache({ ...this.opts, file: this.file }).then(
      (entries) => {
        for (const entry of entries) {
          if (!isPersistableKey(entry.key)) {
            this.refused += 1;
            continue;
          }
          // Re-apply the entry's own remaining lifetime rather than restarting
          // its TTL: persisting an entry must not extend it. `snapshot` already
          // filtered expired rows, so this is positive.
          cache.set(entry.key, entry.value, { ttlMs: Math.max(1, entry.expiresAt - Date.now()) });
          this.restoredCount += 1;
        }
      },
      () => {
        this.failed += 1;
      },
    );
    return this.loaded;
  }

  /**
   * Queue a debounced save of the current cache contents.
   *
   * The entries are held here, not captured in the closure, so a {@link flush}
   * can write exactly what the timer would have written. Both race for that
   * snapshot and whoever takes it clears the field, so a save happens once and
   * its stats are counted once.
   */
  scheduleSave(cache: LruTtlCache<unknown> | null): void {
    if (!cache) return;
    // Snapshot at schedule time and write that, so a later mutation's
    // invalidation (which the next schedule will capture) is never undone by a
    // save that was queued before it.
    this.pendingEntries = cache.snapshot();
    // Arm the marker for the window we are about to open (#1279). Written
    // BEFORE the timer is armed, so there is no instant at which a save is
    // pending but unannounced — the ordering is the whole mechanism. A hard
    // kill inside the window then leaves evidence the next process can report.
    //
    // Re-armed on every coalescing read rather than only the first, so the
    // count reflects what is actually pending at the moment of the kill
    // instead of the size of the first read in the burst.
    armPendingMarker(this.pendingMarker, this.pendingEntries.length);
    if (this.pendingSave !== null) clearTimeout(this.pendingSave);
    this.pendingSave = this.schedule(() => {
      this.pendingSave = null;
      this.runSave(savePersistedCache);
    }, CACHE_PERSIST_DEBOUNCE_MS);
  }

  /**
   * Write the pending save now instead of waiting out the debounce (#1266).
   *
   * Resolves once the write has landed. Safe to call when nothing is pending,
   * and safe to call twice: the pending snapshot is taken by whichever of the
   * timer and this call gets there first, so a flush cannot double-count a save
   * that already ran.
   */
  async flush(): Promise<void> {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    await this.runSave(savePersistedCache);
  }

  /**
   * The synchronous flush, for the `exit` event and signal handlers (#1266).
   *
   * `exit` listeners run synchronously and the process is gone the moment they
   * return, so this cannot await — see {@link savePersistedCacheSync}. The
   * counters are still updated, so a caller that inspects `stats()` after a
   * flush sees a save that actually happened, or a failure that actually
   * occurred, rather than a silent no-op.
   */
  flushSync(): void {
    if (this.pendingSave !== null) {
      clearTimeout(this.pendingSave);
      this.pendingSave = null;
    }
    const entries = this.pendingEntries;
    if (entries === null) return;
    this.pendingEntries = null;
    try {
      const stats = savePersistedCacheSync(entries, { ...this.opts, file: this.file });
      this.refused += stats.refused;
      this.oversize += stats.oversize;
    } catch {
      this.failed += 1;
    }
  }

  /**
   * Run one save against the pending snapshot, if there still is one.
   *
   * Taking the snapshot BEFORE the write is what makes this safe to call from
   * both the timer and {@link flush}: the second caller finds `null` and does
   * nothing, so one queued save is never written or counted twice.
   */
  private async runSave(
    save: (entries: PersistedEntry[], opts: CachePersistOptions) => Promise<CachePersistStats>,
  ): Promise<void> {
    const entries = this.pendingEntries;
    if (entries === null) return;
    this.pendingEntries = null;
    try {
      const stats = await save(entries, { ...this.opts, file: this.file });
      this.refused += stats.refused;
      this.oversize += stats.oversize;
    } catch {
      this.failed += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Shutdown flush (#1266)
// ---------------------------------------------------------------------------

/**
 * The controller whose pending save a terminating process must still write.
 *
 * A single slot rather than a set: the server constructs one client per
 * process, so there is exactly one file to flush. A set would grow for the
 * lifetime of any process that made several clients (every test run does) and
 * would then write every one of those files during `exit`.
 */
let activePersist: CachePersistController | null = null;

/** Whether the process-level hooks have been installed. */
let exitFlushInstalled = false;

/**
 * Flush a pending save when the process is going away (#1266).
 *
 * The debounce is a 250 ms timer, and a pending timer keeps the event loop
 * alive, so a process that simply runs out of work still fires it — the loss
 * needs a termination that skips the loop, which is exactly what a host that
 * restarts the server per session does.
 *
 * What each hook can and cannot do was measured on this Node rather than
 * assumed, and the three cases need different mechanisms:
 *
 *   - `process.exit()` and an uncaught throw both run `exit` listeners, and
 *     run them SYNCHRONOUSLY — a promise started there is discarded, never
 *     awaited. Hence the synchronous write.
 *   - SIGINT/SIGTERM with Node's default disposition run NO JavaScript at all:
 *     no `exit` event, no `beforeExit`. A handler has to be installed for the
 *     process to get a chance to save, and it re-raises afterwards so the
 *     default termination (and the 128+n exit status a supervisor reads) is
 *     unchanged.
 *   - `beforeExit` is deliberately not used. It fires only once the loop has
 *     drained, and the pending debounce timer is what keeps the loop alive, so
 *     by the time it could run the save has already happened.
 *
 * SIGHUP and SIGQUIT are handled here for the first time (#1279). They were
 * missing, and the gap was real rather than theoretical: both are ordinary
 * terminations — SIGHUP from a closing terminal or an ssh session ending, and
 * under some supervisors a hard-stop after a SIGTERM grace period; SIGQUIT from
 * a `kill -QUIT`, and the signal behind a terminal's quit key. A process that
 * handled SIGTERM but not SIGHUP would flush politely on the polite signal and
 * lose the write on the impolite one. This was confirmed by measurement on this
 * Node rather than assumed: SIGINT, SIGTERM, SIGHUP and SIGQUIT all reach a
 * handler when one is installed, and SIGKILL reaches nothing at all.
 */
function installExitFlush(): void {
  if (exitFlushInstalled) return;
  exitFlushInstalled = true;

  process.on('exit', () => {
    try {
      activePersist?.flushSync();
    } catch {
      // An `exit` listener that throws would replace the real exit reason with
      // a spurious failure. A cache is an optimisation; losing it must not
      // change how the process reports why it stopped.
    }
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    // `once`, not `on`: the handler re-raises the signal at the end, and a
    // persistent listener would receive that re-raise and call itself again.
    // With `once` the second delivery finds no listener, so the default
    // disposition applies and the process dies of the signal as it would have
    // without this handler (exit status 128 + signum). This is the same shape
    // `ensureExitCleanup` in src/tools/scenes.ts uses.
    process.once(signal, () => {
      try {
        activePersist?.flushSync();
      } catch {
        // Same reasoning as the `exit` listener: never let the cache change
        // the termination semantics.
      }
      // Re-raise so installing this handler does not turn "SIGTERM stops the
      // server" into "SIGTERM is ignored".
      process.kill(process.pid, signal);
    });
  }
}

export class SpotifyClient {
  private tokens: TokenData | null = null;
  private loadPromise: Promise<TokenData> | null = null;

  // Rate limiting
  /**
   * Earliest time the next request may START (#892). Every launch reserves a
   * slot here BEFORE it waits, so N concurrent requests are paced against one
   * shared reservation counter instead of each reading a timestamp another
   * task is about to overwrite. `_lastRequestTime` could only describe a
   * strictly serial funnel: with more than one request in flight, "when did we
   * last start" stops being a number any wait can be derived from.
   */
  private _nextStartAt = 0;
  private _rateLimitUntil = 0;
  /**
   * Consecutive 429s, and when the last one landed (#892). Reset by any
   * request that was not throttled, and aged out past the streak window.
   */
  private _throttleStreak = 0;
  private _lastThrottleSeenAt = 0;
  // Last throttling event this client observed (#56).
  private _lastThrottle: { retryAfterSec: number; waitedMs: number; at: number } | null = null;
  // Request/quota usage tracking (#904): cumulative count plus per-request
  // timestamps (pruned to the longest exposed window). Maintained in _drain,
  // the single funnel every queued API call passes through. Cache hits bypass
  // the queue and cost no quota, so they are not counted.
  private _requestsTotal = 0;
  private _requestTimes: number[] = [];

  // Immutable-read TTL cache (#54) — null when disabled. Re-assigned by
  // `switchAccount` (#602) because a cache keyed by request rather than by
  // account must not survive a change of account; see that method.
  cache: LruTtlCache<unknown> | null;
  // Exact wire size of each body this client parsed (#894), keyed by the
  // parsed value, so the cache charges the bytes Spotify actually sent rather
  // than serializing every payload a second time to measure it. Weak, so it
  // never keeps a payload alive beyond the cache's own reference.
  private readonly _bodySizes = new WeakMap<object, number>();
  // ETag validators for conditional reads (#601) — null when disabled. Holds
  // the payload an ETag identifies so a 304 can be answered without a body.
  // Re-assigned by `switchAccount` (#602) for the same reason as `cache`.
  validators: ValidatorStore<unknown> | null;
  /**
   * Monotonic counter bumped by every invalidation (#893). A read captures it
   * before it goes to the network and refuses to STORE its body if it moved
   * while the request was in flight.
   *
   * This is the correctness half of scoped invalidation. Dropping keys at
   * mutation time is not sufficient on its own: the funnel runs up to
   * `maxConcurrency` requests at once, so a read issued BEFORE a mutation can
   * complete AFTER it. That read's body describes the pre-mutation world, and
   * storing it would re-seed the entry the mutation just invalidated — serving
   * stale data for the full TTL, with the invalidation having already run. A
   * wholesale `clear()` did not prevent this either; scoping does not make it
   * worse, but only a generation check actually closes it.
   *
   * The read still RETURNS its own body to its caller: it is a truthful
   * answer to the question that was asked. Only the write into shared state is
   * suppressed.
   */
  private _invalidationEpoch = 0;
  /**
   * What the recent invalidations actually dropped, keyed by the epoch that
   * produced them (#1249). Bounded, and consulted only when the epoch has
   * moved — see {@link invalidatedSince}, which fails closed.
   */
  private readonly _invalidationLog: InvalidationEvent[] = [];
  /**
   * Optional cross-process persistence for the catalog cache (#893). Null
   * unless `SPOTIFY_MCP_CACHE_PERSIST=1`. Only ever holds allowlisted,
   * non-`/me` catalog reads — see {@link isPersistableKey}.
   */
  private _persist: CachePersistController | null;
  /**
   * The token file this client reads, refreshes and writes (#609). Resolved
   * once, at construction, from the same function `loadTokens` and
   * `saveTokens` call. Public because the doctor reports on the very file the
   * client authenticates with — a diagnostic that named a different one would
   * be diagnosing something nobody is using.
   *
   * Not `readonly` any more since #602: `switchAccount` re-points it at the
   * new account's file. It is still assigned in exactly one place at
   * construction, so "one resolution per client" still holds for a client that
   * never switches; a session that DOES switch has one resolution per switch,
   * which is the point.
   */
  tokenFile: string;
  private readonly fetchAllCap: number;
  /**
   * Whether this client has a read cache at all, and the sizing it was built
   * with. Retained so `switchAccount` (#602) can rebuild an EQUIVALENT cache
   * rather than either dropping the setting or inventing defaults — a switch
   * that quietly turned caching on where it was off, or resized it, would
   * change the client's behaviour in a way the switch tool never mentioned.
   */
  private readonly _cacheEnabled: boolean;
  private readonly _cacheOpts: SpotifyClientOptions['cache'];
  private readonly _validatorTtlMs: SpotifyClientOptions['validatorTtlMs'];
  /**
   * The persist options this client was built with, kept so `switchAccount`
   * rebuilds an equivalent controller. A caller that pinned
   * `cachePersist.file` keeps that pin across a switch: it asked for that
   * exact file, and silently redirecting it would be a worse surprise than
   * the sharing it might cause. Test hermeticity is the common case.
   */
  private readonly _persistOpts: SpotifyClientOptions['cachePersist'];
  /**
   * Ceiling on requests in flight at once (#892). Read once at construction,
   * like fetchAllCap, so one client has one stable bound.
   */
  private readonly _maxConcurrency: number;
  /** Requests currently open in the funnel; also its permit count (#892). */
  private _inFlight = 0;
  private _peakInFlight = 0;
  private readonly random: () => number;

  // Long-walk progress reporting (#65); index.ts installs a notifier that
  // forwards events as MCP progress notifications.
  private progressReporter: ((info: PageProgress) => void) | null = null;
  private walkCounter = 0;

  constructor(opts: SpotifyClientOptions = {}) {
    this.tokenFile = opts.tokenFile ?? getTokenFilePath();
    this.fetchAllCap = opts.fetchAllCap ?? getConfig().fetchAllCap;
    this._maxConcurrency = opts.maxConcurrency ?? getConfig().maxConcurrency;
    this.random = opts.random ?? Math.random;
    this._cacheEnabled = !opts.disableCache;
    this._cacheOpts = opts.cache;
    this._validatorTtlMs = opts.validatorTtlMs;
    this._persistOpts = opts.cachePersist;
    this.cache = opts.disableCache ? null : new LruTtlCache<unknown>(opts.cache);
    this.validators = opts.disableCache
      ? null
      : new ValidatorStore<unknown>(opts.validatorTtlMs, opts.cache?.maxEntries);
    this._persist = opts.disableCache || !cachePersistEnabled()
      ? null
      : new CachePersistController(cachePersistPath(process.env, { tokenFile: this.tokenFile }), opts.cachePersist);
    // Restore before the first read can miss: a load that lands after a read
    // would make the second process pay the fetch anyway, and the restored
    // entries are deadline-checked on load so nothing expired is revived.
    if (this._persist) {
      // Installed only when persistence is actually on, so a process that
      // never writes a cache file registers no process-level handlers (#1266).
      activePersist = this._persist;
      installExitFlush();
      void this._persist.load(this.cache);
    }
  }

  /**
   * Write any debounced cache-persist save now, and wait for it (#1266).
   *
   * The server installs its own flush on the termination paths, so a host does
   * not have to call this; it is the explicit seam for a host that ends a
   * session by other means (a graceful RPC shutdown, a supervisor that closes
   * stdin and then waits), and for tests. A no-op when persistence is off or
   * nothing is queued, and calling it twice does not save twice.
   */
  async flushCachePersist(): Promise<void> {
    await this._persist?.flush();
  }

  /**
   * Act as a different account for every subsequent call (#602).
   *
   * This is the whole of the cross-account isolation guarantee, and it is four
   * pieces of state that each have to be dropped or re-pointed. Miss any one
   * and a switched session keeps serving the previous account's data, which
   * is the failure the issue exists to prevent:
   *
   *   1. `tokenFile` re-pointed, so the next token load and the next refresh
   *      read and write the NEW account's file. `loadTokens`/`saveTokens`
   *      take it as an argument for exactly this reason — left to re-resolve,
   *      they would go back to the startup account.
   *   2. `tokens`/`loadPromise` cleared, so the memoized access token of the
   *      previous account is not carried into the new one. `getTokens()`
   *      memoizes its promise, so without this the very first call after a
   *      switch would send the OLD `Authorization` header to the NEW account
   *      and get a 401 that looks like bad credentials rather than a switch.
   *   3. `cache` replaced with a fresh, EMPTY one. The read cache is keyed by
   *      request — method, path, params — and carries no account component,
   *      so a surviving entry is a `/me`-scoped or library-scoped response
   *      being handed to the account that did not fetch it. This is the single
   *      most important line in the method: the persisted cache was already
   *      per-profile on disk (#1249), which is why only the IN-MEMORY half
   *      needed handling.
   *   4. `validators` replaced too, for the same reason with a sharper edge: a
   *      conditional read presents an ETag, and a 304 answers from the stored
   *      payload. A validator from the previous account would therefore
   *      produce a "not modified" answer carrying the PREVIOUS account's
   *      bytes, with no request to notice.
   *
   * The persist controller is rebuilt against the NEW account's cache file and
   * the old one is flushed first, so pending writes land in the file that
   * actually belongs to them. The path comes from `cachePersistPath` with an
   * explicit `tokenFile` rather than a bare call, because the bare form
   * re-resolves from the process environment and would hand back the
   * STARTUP account's `cache.json` — #1249's exact bug, reintroduced one
   * layer out. The naming stays in `cachepersist.ts` for the same reason it
   * lives there: one definition, not a second one in the client.
   *
   * A switch must not race live requests. One already past
   * `ensureValidToken` would finish under the old account and then write its
   * response into the new account's cache, which is the same leak with an
   * extra step — so the `switch_account` tool calls
   * {@link SpotifyClient.drainPendingRequests} first, and this method is not
   * reachable from a path that skips it.
   */
  async switchAccount(tokenFile: string): Promise<void> {
    if (tokenFile === this.tokenFile) return;
    // Land whatever the previous account had queued in ITS cache file first.
    await this._persist?.flush();
    this.tokenFile = tokenFile;
    this.tokens = null;
    this.loadPromise = null;
    this.cache = this._cacheEnabled
      ? new LruTtlCache<unknown>(this._cacheOpts)
      : null;
    this.validators = this._cacheEnabled
      ? new ValidatorStore<unknown>(this._validatorTtlMs, this._cacheOpts?.maxEntries)
      : null;
    this._persist = this._cacheEnabled && cachePersistEnabled()
      ? new CachePersistController(
        cachePersistPath(process.env, { tokenFile, ...this._persistOpts }),
        this._persistOpts,
      )
      : null;
    if (this._persist) {
      // Same reasoning as the constructor: the process-level flush handlers
      // are installed once and stay, but the controller they reach through
      // must be the live one.
      activePersist = this._persist;
      void this._persist.load(this.cache);
    }
  }

  /**
   * Wait until the funnel is idle — nothing queued, nothing in flight.
   *
   * Used by `switch_account` so the account change lands at a point where no
   * request can still be holding the previous account's token. Parking on the
   * scheduler's own change notification rather than polling: this is the same
   * register-then-re-check dance `_drain` performs, and for the same reason —
   * the state can change between the check and the registration, and a
   * notification that arrives with no waiter registered is simply lost, which
   * would park here forever.
   *
   * Bounded on purpose. A queue that never drains — a long walk, a request
   * parked on a throttle cooldown — is a fact the caller should be told, not a
   * tool call that hangs until the host gives up.
   */
  async drainPendingRequests(timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // Registered BEFORE the idle re-check, and the deadline raced against
      // the notification rather than merely checked before awaiting it: a
      // queue that stays busy changes no state and sends no notification, so
      // a check-then-await would park here for as long as the call takes
      // instead of for the timeout it promised.
      const change = this._waitForChange();
      if (this._inFlight === 0 && this._queued() === 0) {
        change.cancel();
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        change.cancel();
        throw new Error(
          'switch_account: requests were still in flight after '
          + `${timeoutMs}ms. Refusing to switch mid-flight — a request already holding the `
          + "previous account's token would finish against the new one. Retry once the queue settles.",
        );
      }
      // The timer is deliberately NOT unref'd. An unref'd deadline does not
      // merely fail to hold the loop open — when the in-flight request is the
      // only other pending work and it is itself blocked, an unref'd timer is
      // never reached at all and the process exits with this await unsettled.
      // It cannot outlive the function either way: the race settles within
      // `remaining` and the timer fires at `remaining`.
      await Promise.race([
        change.promise,
        new Promise<void>((resolve) => { setTimeout(resolve, remaining); }),
      ]);
    }
  }

  /**
   * Install a callback invoked after every page of every getAllPages walk.
   * Callbacks must not throw meaningful errors — they are wrapped, but treat
   * them best-effort. Pass null to remove.
   */  setProgressReporter(fn: ((info: PageProgress) => void) | null): void {
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

  /** Structured rate-limit + quota-usage state for the spotify://me/rate-limit resource. */
  getRateLimitStatus(): RateLimitStatus {
    return {
      lastThrottleAt: this._lastThrottle?.at ?? null,
      retryAfterSec: this._lastThrottle?.retryAfterSec ?? null,
      cooldownRemainingMs: Math.max(0, this._rateLimitUntil - Date.now()),
      requestsTotal: this._requestsTotal,
      requestsLastMinute: this.requestsSince(60_000),
      requestsLastHour: this.requestsSince(3_600_000),
      ...this.cacheStats(),
      ...this.cachePersistStats(),
      inFlight: this._inFlight,
      maxConcurrency: this._maxConcurrency,
      peakInFlight: this._peakInFlight,
      throttleStreak: this._throttleStreak,
    };
  }

  /**
   * Read-cache entry count, retained bytes, budget and refused-write count
   * (#894), or an empty object when the cache is disabled — so a caller can
   * report "no cache" instead of "cache is empty".
   */
  private cacheStats(): Pick<RateLimitStatus, 'cacheEntries' | 'cacheBytes' | 'cacheMaxBytes' | 'cacheSkippedOversize'> {
    if (!this.cache) return {};
    return {
      cacheEntries: this.cache.size,
      cacheBytes: this.cache.bytes,
      cacheMaxBytes: this.cache.limits.maxBytes,
      cacheSkippedOversize: this.cache.skippedOversize,
    };
  }

  /**
   * Persistence counters (#893), or an empty object when persistence is off —
   * so a caller can report "not enabled" rather than "restored nothing", which
   * are different facts.
   */
  private cachePersistStats(): Pick<
    RateLimitStatus,
    | 'cachePersist'
    | 'cacheRestored'
    | 'cachePersistFailed'
    | 'cachePersistRefused'
    | 'cachePersistOversize'
    | 'cachePersistLost'
  > {
    if (!this._persist) return this.cache ? { cachePersist: false } : {};
    const stats = this._persist.stats();
    return {
      cachePersist: true,
      cacheRestored: stats.restored,
      cachePersistFailed: stats.failed,
      cachePersistRefused: stats.refused,
      cachePersistOversize: stats.oversize,
      // Reported only when non-zero, so a healthy session's row is unchanged
      // and a detected hard kill is the thing that draws the eye (#1279).
      ...(stats.lost > 0 ? { cachePersistLost: stats.lost } : {}),
    };
  }

  /** Record the wire size of a parsed body (#894). Non-objects are not cached. */
  private noteBodyBytes(value: unknown, bytes: number): void {
    if (typeof value === 'object' && value !== null) this._bodySizes.set(value, bytes);
  }

  /**
   * Retained size of a value about to be cached (#894): the wire length we
   * measured when we parsed it, or undefined so the cache estimates — which
   * only happens for a non-object payload, since every cached body is parsed
   * through the branch that measures it.
   */
  private bodyBytes(value: unknown): number | undefined {
    if (typeof value === 'object' && value !== null) return this._bodySizes.get(value);
    return undefined;
  }

  /** Cumulative API requests issued through the drain queue (#904). */
  get requestsTotal(): number {
    return this._requestsTotal;
  }

  /**
   * Rolling-window request count: queued API calls issued in the trailing
   * `windowMs` (#904). Powers the windowed quota readouts.
   */
  requestsSince(windowMs: number): number {
    const cutoff = Date.now() - Math.max(0, windowMs);
    let n = 0;
    for (let i = this._requestTimes.length - 1; i >= 0; i--) {
      if (this._requestTimes[i]! >= cutoff) n++;
      else break;
    }
    return n;
  }

  /** Record one issued request; called once per drained queue task (#904). */
  private recordRequest(): void {
    const now = Date.now();
    this._requestsTotal++;
    this._requestTimes.push(now);
    const cutoff = now - SpotifyClient.REQUEST_WINDOW_RETAIN_MS;
    let drop = 0;
    while (drop < this._requestTimes.length && this._requestTimes[drop]! < cutoff) drop++;
    if (drop > 0) this._requestTimes.splice(0, drop);
  }

  /**
   * Record a completed mutation in the opt-in history JSONL (#64). Only the
   * whitelisted fields survive serialization; appendHistory never rejects, so
   * a history problem can never fail the underlying mutation — it is counted
   * and reported by spotify_doctor instead (#591).
   */
  private recordMutation(method: string, path: string, response: unknown): Promise<void> {
    const snapshotId =
      response !== null && typeof response === 'object' && 'snapshot_id' in response
        ? String(response.snapshot_id)
        : undefined;
    // Typed against MutationRecord (#591): a renamed or mistyped field is a
    // compile error rather than a silently dropped audit field. `who` is the
    // tool running on this async context, or undefined outside one (the writer
    // then records the historical 'agent' default).
    const record: MutationRecord = {
      method,
      path,
      who: currentToolName(),
      snapshot_id: snapshotId,
    };
    // `this.tokenFile` selects whose ledger this lands in (#1364). It is read
    // here, on the request that caused the write, rather than captured once:
    // `switchAccount` re-points the field, so a switch between two mutations
    // files each under the account that actually made it.
    return appendHistory(record, this.tokenFile);
  }

  /**
   * Post-mutation bookkeeping (#54/#64): drop every cached read (a mutation
   * may affect any previously cached object) and record the mutation in the
   * opt-in history JSONL. Never fails the underlying mutation.
   */
  private afterMutation(method: string, path: string, response: unknown): void {
    this._invalidationEpoch += 1;
    const plan = invalidationPlan(method, path);
    if (plan.scope === 'all') {
      this.cache?.clear();
      this.validators?.clear();
    } else {
      for (const prefix of plan.payload) this.cache?.deleteByPrefix(prefix);
      for (const prefix of plan.validators) this.validators?.deleteByPrefix(prefix);
    }
    this.recordInvalidation(plan);
    // A mutation also re-shapes what is worth persisting, so a save queued
    // before it must not write the dropped entries back to disk.
    this._persist?.scheduleSave(this.cache);
    void this.recordMutation(method, path, response);
  }

  /**
   * Remember what this invalidation actually dropped (#1249).
   *
   * The epoch alone answers "has anything been invalidated since this request
   * went out?", which is too blunt to be the whole question: a
   * `POST /me/player/queue` drops ZERO payload prefixes, and a global answer of
   * "yes" made it discard catalog reads that landed after it — which is the
   * exact cost the scoped-invalidation change claims to remove. This log lets
   * a racing read ask the narrower question instead.
   */
  private recordInvalidation(plan: InvalidationPlan): void {
    this._invalidationLog.push({
      epoch: this._invalidationEpoch,
      all: plan.scope === 'all',
      payload: plan.scope === 'all' ? [] : [...plan.payload],
      validators: plan.scope === 'all' ? [] : [...plan.validators],
    });
    if (this._invalidationLog.length > INVALIDATION_LOG_LIMIT) {
      this._invalidationLog.splice(0, this._invalidationLog.length - INVALIDATION_LOG_LIMIT);
    }
  }

  /**
   * Did anything invalidate `key` since this read started? FAILS CLOSED.
   *
   * The prefixes are the same boundary-aware ones the invalidation itself used
   * to delete keys, so "would this key have been dropped?" is answered by the
   * identical comparison rather than by a second, subtler notion of matching.
   *
   * Two ways to answer "yes" without evidence, both deliberately:
   *   - the log no longer reaches back to this read, so an invalidation it
   *     raced has been evicted and cannot be reasoned about;
   *   - the invalidation was a full clear, which exempts nothing.
   * Losing a cache fill is recoverable; serving a stale body is not.
   */
  private invalidatedSince(epoch: number, key: string): boolean {
    if (this._invalidationEpoch === epoch) return false;
    const log = this._invalidationLog;
    if (log.length === 0 || log[0].epoch > epoch + 1) return true;
    for (const event of log) {
      if (event.epoch <= epoch) continue;
      if (event.all) return true;
      if (event.payload.some((prefix) => key.startsWith(prefix))) return true;
      if (event.validators.some((prefix) => key.startsWith(prefix))) return true;
    }
    return false;
  }

  private getTokens(): Promise<TokenData> {
    if (!this.loadPromise) {
      this.loadPromise = loadTokens(this.tokenFile).then(
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
      // Read through the local-read guard (#623): the token file is a
      // server-owned store, so the root is its own directory. A FIFO planted
      // there must not block this refresh forever, and an oversized file must
      // not be buffered. A refusal is simply "no fresher token" — the same
      // outcome as an unreadable file, which is what this catch has always
      // meant, so a guard refusal falls through to a normal refresh.
      // The ACTIVE profile's file, resolved once at construction (#609). This
      // read used to consult a module-level env-only constant, so under
      // `--profile work` the guard compared the work profile's tokens against
      // the default profile's and adopted the other account outright.
      const stored = JSON.parse(
        await readLocalFile({ roots: ownStoreRoots(this.tokenFile), tool: 'token refresh', target: this.tokenFile }),
      ) as TokenData;
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

    // Transient refresh failures get the same bounded attempt budget as the API
    // path (#677). The loop cannot run away: MAX_ATTEMPTS dispatches, and each
    // re-send is a form-encoded POST that grants no access, so a retry here
    // cannot double-apply anything.
    for (let attempt = 0; ; attempt++) {
      const failure = await this.refreshOnce(body.toString(), tokens);
      if (failure === null) return;

      // A still-valid access token rides out a transient refresh failure and
      // the request proceeds (#109). A refused client id is not transient, so
      // it is surfaced even though the old token would have worked.
      if (failure.rideOut && Date.now() < tokens.expires_at) return;

      if (failure.retry && attempt + 1 < MAX_ATTEMPTS) {
        await sleep(this.backoffDelayMs(attempt));
        continue;
      }

      throw new SpotifyApiError(
        failure.status,
        failure.message,
        failure.retryAfterSec,
        failure.reason,
      );
    }
  }

  /**
   * One refresh round-trip against the token endpoint. Returns the classified
   * failure, or `null` when the refresh succeeded and the new tokens are
   * already stored.
   *
   * Split out of doRefreshTokens so that each of the three outcomes — no
   * response at all, a non-ok response, a 2xx — has exactly one return path
   * and therefore exactly one classification, with no state carried between
   * attempts.
   */
  private async refreshOnce(formBody: string, tokens: TokenData): Promise<TokenFailure | null> {
    let res: Response;
    try {
      res = await fetchWithTimeout(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody,
      });
    } catch (err) {
      // No response arrived, so there is no status and no body to classify
      // from — the thrown error's own shape is the only evidence there is,
      // and it is never merged with the response-borne classes (#677).
      return classifyTokenTransportFailure(err, this.tokenFile);
    }

    if (!res.ok) {
      // Classify from what the response actually said (#109/#677), including
      // whether its body was readable at all — "we could not read it" and
      // "we read it and it named no cause" are different facts.
      let errorBody: unknown;
      let bodyReadable = true;
      try {
        errorBody = await res.json();
      } catch {
        bodyReadable = false;
      }
      return classifyTokenResponse(res.status, res.headers.get('Retry-After'), errorBody, bodyReadable, this.tokenFile);
    }

    // A 2xx whose body will not parse. Rides out a transient failure exactly
    // like a transport error — nothing was refreshed — but is its own class:
    // Spotify did answer, it answered with something unreadable. Left
    // unguarded this raised a raw SyntaxError, the one error a client method
    // could throw that is not a SpotifyApiError (#674).
    let data: { access_token: string; expires_in: number; refresh_token?: string };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      return {
        category: 'unclassified',
        reason: TOKEN_UNREADABLE_RESPONSE,
        status: 503,
        rideOut: true,
        retry: false,
        message: withTokenFile(
          'Spotify token service returned an unreadable response — no valid access token to continue with',
          this.tokenFile,
        ),
      };
    }

    // Guard against a malformed expires_in (#109): NaN/undefined would poison
    // expires_at forever, so treat it as already expired — the next request
    // will attempt another refresh instead of sending a dead token.
    const expiresIn = Number.isFinite(data.expires_in) ? data.expires_in : 0;

    this.tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? tokens.refresh_token,
      expires_at: Date.now() + expiresIn * 1000,
    };

    await saveTokens(this.tokens, this.tokenFile);
    return null;
  }

  /**
   * Two-lane request scheduler (#133): interactive requests ('normal') drain
   * before bulk-walk pages ('low'), so multi-minute library walks can no
   * longer starve quick reads. FIFO within a lane; pacing and rate-limit
   * waits apply to every task regardless of lane.
   */
  private _lanes: {
    normal: Array<LaneTask>;
    low: Array<LaneTask>;
  } = { normal: [], low: [] };
  private _draining = false;
  /** Schedulers parked on a permit or on work (#892). */
  private _changeWaiters: Array<() => void> = [];

  /**
   * Waiter aging (#133): a low-priority task waiting longer than
   * LOW_AGING_MS is promoted ahead of queued normal tasks, so a busy
   * interactive session cannot starve background walks indefinitely.
   */
  private static readonly LOW_AGING_MS = 15_000;

  /**
   * Longest rolling window retained for requestsSince() (#904): one hour
   * covers the widest count exposed via getRateLimitStatus().
   */
  private static readonly REQUEST_WINDOW_RETAIN_MS = 3_600_000;

  /**
   * Consecutive 429s that trip the fail-fast breaker (#892), and the window
   * they must land inside to count as consecutive. A request that was NOT
   * throttled resets the streak outright.
   */
  private static readonly THROTTLE_STREAK_TRIP = 3;
  private static readonly THROTTLE_STREAK_WINDOW_MS = 30_000;

  private enqueue<T>(
    fn: (attempts: number) => Promise<T>,
    priority: 'normal' | 'low' = 'normal',
    signal: AbortSignal | undefined = currentRequestSignal(),
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A task whose caller has already cancelled is NOT dropped here. It is
      // enqueued and then dropped by `_executeTask` before the start gate and
      // before `recordRequest()` (#676). A pre-enqueue drop was tried and
      // removed: it was externally indistinguishable from the dequeue-time one
      // (same status, same zero requests, same zero counted requests), so it
      // was a second place to keep in sync for no observable difference. The
      // check that a cancellation can NOT be served from is `get`'s entry
      // check, which runs before this is ever reached.
      this._lanes[priority].push({
        run: fn as (attempts: number) => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
        attempts: 0,
        priority,
        signal,
      });
      // Wake a drain parked mid-cohort: a task arriving while a permit is free
      // must start on the next tick, not when the request already running
      // happens to finish.
      this._notify();
      this._drain();
    });
  }

  /**
   * Park until the funnel's state changes — a permit comes back, or work is
   * enqueued. The returned `cancel` drops a waiter the caller decided not to
   * await, so a scheduler that re-checks its state cannot accumulate waiters
   * nobody will ever consume.
   */
  private _waitForChange(): { promise: Promise<void>; cancel: () => void } {
    let settle!: () => void;
    const promise = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const waiter = (): void => settle();
    this._changeWaiters.push(waiter);
    return {
      promise,
      cancel: () => {
        const at = this._changeWaiters.indexOf(waiter);
        if (at >= 0) this._changeWaiters.splice(at, 1);
      },
    };
  }

  /** Release every parked scheduler, then forget it — one change, one wake. */
  private _notify(): void {
    if (this._changeWaiters.length === 0) return;
    const waiters = this._changeWaiters;
    this._changeWaiters = [];
    for (const waiter of waiters) waiter();
  }

  /**
   * The ONE shared gate for every request in the process (#892): the pacing gap
   * and the `Retry-After` cooldown resolve to a single per-launch reservation,
   * so N queued calls wait out ONE window instead of one window each.
   *
   * The slot is reserved BEFORE the wait, which is what makes this a gate
   * rather than a read: N workers released by the same event-loop turn cannot
   * all read "now" and all start. After the wait, a start that landed late
   * (event-loop lag, a coarse timer) pushes the counter forward from the
   * moment it actually started, so the next launch still sees a full gap
   * behind it.
   *
   * That correction is MONOTONE. Writing it unguarded would move the counter
   * backwards: three launches reserving slots T, T+100 and T+200 leave
   * `_nextStartAt` at T+300, and the first of them to wake at T+100 would
   * then set it to T+200 — handing a fourth launch the slot the third one
   * already holds, and letting two requests start inside one gap.
   */
  private async _awaitStartSlot(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(this._nextStartAt, this._rateLimitUntil);
    this._nextStartAt = slot + REQUEST_START_GAP_MS;
    const waitMs = slot - now;
    if (waitMs > 0) await sleep(waitMs);
    const earliestNextStart = Date.now() + REQUEST_START_GAP_MS;
    if (earliestNextStart > this._nextStartAt) this._nextStartAt = earliestNextStart;
  }

  /** Record one observed 429 against the consecutive-throttle breaker. */
  private noteThrottled(now: number): void {
    this._throttleStreak =
      now - this._lastThrottleSeenAt > SpotifyClient.THROTTLE_STREAK_WINDOW_MS
        ? 1
        : this._throttleStreak + 1;
    this._lastThrottleSeenAt = now;
  }

  /**
   * A settled request that was NOT throttled breaks the streak (#892): two
   * 429s either side of a 404 are not a run of throttling, and treating them
   * as one would keep the breaker latched on a client that is answering
   * normally again.
   */
  private noteNotThrottled(err: unknown): void {
    if (err instanceof SpotifyApiError && err.status === 429) return;
    this._throttleStreak = 0;
  }

  /**
   * The error a newly launched task fails fast with while the breaker is
   * latched, or null when it is not (#892). A run of consecutive 429s means
   * the quota wall has not moved: queueing more work into it turns a bounded
   * wait into an unbounded one, and the caller is better served an actionable
   * 429 naming the wait than a request that never issues.
   */
  private _throttleBreaker(): SpotifyApiError | null {
    if (this._throttleStreak < SpotifyClient.THROTTLE_STREAK_TRIP) return null;
    const remaining = this._rateLimitUntil - Date.now();
    // The window is what latches the breaker; once it passes the streak is
    // history, not a standing refusal to send.
    if (remaining <= 0) return null;
    const retryAfterSec = Math.max(1, Math.ceil(remaining / 1000));
    return new SpotifyApiError(
      429,
      `Rate limited — ${this._throttleStreak} consecutive 429s and the Retry-After window has not `
        + `passed; this request was not sent. Retry after ${retryAfterSec}s.`,
      retryAfterSec,
    );
  }

  /** Tasks waiting for a permit, across both lanes. */
  private _queued(): number {
    return this._lanes.normal.length + this._lanes.low.length;
  }

  /**
   * Bounded-concurrency drain (#892).
   *
   * The loop used to `await` each task before selecting the next, so at most
   * one HTTP request was ever in flight process-wide and a 50-lookup composite
   * held the funnel for the length of all fifty. It now keeps up to
   * `maxConcurrency` permits busy and hands a permit back the moment a task
   * settles.
   *
   * Permits: `_executeTask` takes one on entry and returns it in a `finally`,
   * so success, an HTTP error, a thrown exception, a gate rejection and a
   * throttle re-queue all release, and the release notifies the loop. A leak
   * would show up as a pool that silently shrinks — the refill stops early,
   * concurrency falls to 1, and the queue serialises again with nothing
   * reporting an error.
   */
  private _drain(): void {
    if (this._draining) return;
    this._draining = true;
    void (async () => {
      try {
        for (;;) {
          while (this._inFlight < this._maxConcurrency) {
            const next = selectNextLaneTask(
              this._lanes.normal,
              this._lanes.low,
              Date.now(),
              SpotifyClient.LOW_AGING_MS,
            );
            if (!next) break;
            void this._executeTask(next);
          }
          if (this._inFlight === 0 && this._queued() === 0) break;
          const change = this._waitForChange();
          // Re-read AFTER registering: a task may have been enqueued between
          // the selection pass above and this registration, and its
          // notification found no waiter to wake. Only re-loop when there is
          // genuinely something to launch — a free permit AND queued work.
          // Testing the permit alone would spin here for the whole time a
          // partial cohort is in flight against an empty queue.
          if (this._inFlight < this._maxConcurrency && this._queued() > 0) {
            change.cancel();
            continue;
          }
          await change.promise;
        }
      } finally {
        this._draining = false;
        // Tasks enqueued during the final awaits restart the drain.
        if (this._queued() > 0) this._drain();
      }
    })();
  }

  /**
   * Run one queued task under a permit, and always give the permit back.
   *
   * The body is one `try` so there is exactly one release site: nothing below
   * — the breaker, the gate, the task itself, the re-queue — can return while
   * holding a permit. Every failure path settles the caller's promise here;
   * none may escape as a rejection of this function, which would reject the
   * drain's race and stop the funnel for good.
   */
  private async _executeTask(task: LaneTask): Promise<void> {
    this._inFlight++;
    if (this._inFlight > this._peakInFlight) this._peakInFlight = this._inFlight;
    try {
      // Fail fast while the consecutive-429 breaker is latched. A rejection,
      // not a wait: nothing is sent, and the caller gets the wait it would
      // otherwise have paid as retryAfterSec.
      const breaker = this._throttleBreaker();
      if (breaker) {
        task.reject(breaker);
        return;
      }
      // A task cancelled while it sat in the lane is dropped HERE, before the
      // start gate and before `recordRequest()`. Both are load-bearing: a
      // permit spent on an abandoned call delays the next live caller, and a
      // request counted for one that was never sent inflates the quota figures
      // a caller is told to budget against (#676).
      if (task.signal?.aborted) {
        task.reject(cancelledError(undefined, undefined));
        return;
      }
      await this._awaitStartSlot();
      this.recordRequest();
      let result: unknown;
      try {
        result = await task.run(task.attempts);
      } catch (err) {
        if (err instanceof ThrottleRetry) {
          // Back on the queue with one attempt spent. The wait belongs to the
          // shared gate: every throttled caller parks on the same cooldown and
          // is released by the same window, rather than each sleeping where it
          // stands and blocking everything behind it.
          this._lanes[task.priority].push({
            run: task.run,
            resolve: task.resolve,
            reject: task.reject,
            // Re-queued, not still-waiting: the aging clock restarts so a
            // throttled walk page cannot jump the queue by accruing age.
            enqueuedAt: Date.now(),
            attempts: task.attempts + 1,
            priority: task.priority,
            signal: task.signal,
          });
          this._notify();
          return;
        }
        this.noteNotThrottled(err);
        task.reject(err);
        return;
      }
      this.noteNotThrottled(null);
      task.resolve(result);
    } catch (err) {
      // The gate itself failed (a throwing sleep, say). The task still has to
      // settle and the permit still has to come back.
      this.noteNotThrottled(err);
      task.reject(err);
    } finally {
      this._inFlight--;
      // Hand the permit on immediately, and wake a scheduler parked waiting
      // for one. The release and the wake are adjacent and synchronous, so a
      // drain that re-reads `_inFlight` can never see the stale count.
      this._notify();
    }
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const url = `${BASE_URL}${path}`;
    if (!params || Object.keys(params).length === 0) return url;
    return `${url}?${new URLSearchParams(params)}`;
  }

  /**
   * Jittered exponential backoff for the `retryCount`-th retry: 250 ms, then
   * 500 ms, each plus a uniform 0–250 ms of jitter.
   *
   * The jitter is load-bearing, not decoration. Every spotify-mcp process
   * sharing one developer account sees the same 5xx at the same moment, and
   * an unjittered exponential would march them all back in lockstep — the
   * synchronized retry wave that turns one outage into a self-inflicted one.
   */
  private backoffDelayMs(retryCount: number): number {
    const base = RETRY_BACKOFF_BASE_MS * 2 ** retryCount;
    const jitter = this.random() * RETRY_BACKOFF_JITTER_MS;
    return Math.min(base + jitter, RETRY_SLEEP_CAP_SEC * 1000);
  }

  private async rawRequest(
    method: string,
    url: string,
    body?: unknown,
    retryCount = 0,
    contentType?: string,
    conditional?: { ifNoneMatch?: string },
    signal?: AbortSignal,
  ): Promise<Response> {
    // The signal is resolved by the PUBLIC method that owns the call and
    // passed down explicitly, never read from ambient context in here. This
    // body runs inside a queued task, and a task is dispatched by the
    // scheduler under whichever async context happened to wake the drain —
    // not the caller's. Reading `currentRequestSignal()` at this depth would
    // sample the wrong request, or none, and would make a walk's pages judged
    // against a stranger's cancellation.
    //
    // Refuse BEFORE the token refresh and before the fetch: a call whose
    // caller has already gone must cost the account nothing at all (#676).
    if (signal?.aborted) throw cancelledError(method, url);

    await this.ensureValidToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.tokens!.access_token}`,
    };
    if (contentType !== undefined) {
      headers['Content-Type'] = contentType;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    // Conditional read (#601): offer the ETag we already hold, so an unchanged
    // resource comes back as a bodiless 304 instead of a full re-download.
    if (conditional?.ifNoneMatch) headers['If-None-Match'] = conditional.ifNoneMatch;

    let res: Response;
    try {
      res = await fetchWithTimeout(
        url,
        {
          method,
          headers,
          body: body === undefined
            ? undefined
            : contentType !== undefined
              ? String(body)
              : JSON.stringify(body),
        },
        signal,
      );
    } catch (err) {
      // A cancellation is not a transport failure (#676). The caller withdrew
      // the request, so retrying — for an idempotent verb or otherwise — would
      // re-spend the quota they cancelled precisely to stop spending, and the
      // backoff would hold the serialized queue through the wait. It is raised
      // before the idempotency branch below because that branch exists to
      // reason about an UNKNOWN outcome, and a cancelled call is not unknown:
      // the caller knows it wants nothing more.
      if (signal?.aborted) throw cancelledError(method, url);
      // A thrown transport error means no answer arrived, so we also never
      // learned whether the request was applied. Re-sending is safe only for
      // an idempotent verb: re-sending a POST that already mutated something
      // would silently double-apply it (#675). A verb that *did* get an
      // answer is handled below, where 502/503/504 prove it was rejected.
      if (!IDEMPOTENT_METHODS.has(method.toUpperCase()) || retryCount + 1 >= MAX_ATTEMPTS) {
        throw transportFailure(method, url, err);
      }
      await sleep(this.backoffDelayMs(retryCount));
      return this.rawRequest(method, url, body, retryCount + 1, contentType, conditional, signal);
    }

    // A 401-refresh retry, and every re-queue below, carry the signal on. A
    // retry that dropped it would re-enter the ladder on a call the caller has
    // already abandoned.
    // Token expired mid-flight — refresh and retry once
    if (res.status === 401 && retryCount === 0) {
      try {
        await this.doRefreshTokens();
      } catch (err) {
        // A classified token failure (#677) keeps its own status, wait and
        // reason: a 429 from accounts.spotify.com must stay a 429 carrying its
        // Retry-After, and a refused client id must stay an auth failure. Only
        // the context of *why* a refresh was attempted is added.
        if (err instanceof SpotifyApiError && isTokenFailureReason(err.reason)) {
          throw new SpotifyApiError(
            err.status,
            `Spotify rejected the access token and refreshing it failed: ${err.message}`,
            err.retryAfterSec,
            err.reason,
          );
        }
        // The refresh failure must not replace the 401 that describes what is
        // actually wrong. A 400 from accounts.spotify.com used to be thrown
        // in place of this 401 and classified as a validation error, telling
        // a user with an expired token to fix the arguments of a call that
        // took none (#1007). The refresh reason is kept in the message for
        // diagnostics; the status stays 401 so the failure is reported as
        // "could not authenticate; run spotify-mcp auth".
        const reason = err instanceof Error ? err.message : String(err);
        throw new SpotifyApiError(401, `Spotify rejected the access token and refreshing it failed: ${reason}`);
      }
      return this.rawRequest(method, url, body, retryCount + 1, contentType, conditional, signal);
    }

    // Rate limited — differentiate a quota wall from a burst limit (#108).
    // The 429 branch runs on every attempt, not only the first: the 401-refresh
    // retry path commonly lands us at retryCount=1, and a 429 there must still
    // parse Retry-After, attach retryAfterSec to the thrown error, and update
    // the cooldown window — otherwise it falls through to the generic non-ok
    // throw at the bottom of the function and silently drops the rate-limit
    // signal (#671).
    if (res.status === 429) {
      // Parse both RFC 9110 forms (#675): a bare parseInt read delta-seconds
      // only, so an HTTP-date fell to the 1 s floor and the retry came back
      // long before the window Spotify asked for. Garbage still lands on that
      // floor, which keeps it from poisoning _rateLimitUntil with NaN (#20).
      const retryAfter = parseRetryAfter(res.headers.get('Retry-After'));
      const throttledAt = Date.now();
      this._rateLimitUntil = throttledAt + retryAfter * 1000;
      // Every 429 counts, including the ones that end in a throw below — the
      // streak is what tells a burst apart from an isolated throttle.
      this.noteThrottled(throttledAt);

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

      if (reason === 'QUOTA_EXCEEDED') {
        throw new SpotifyApiError(
          429,
          `Spotify developer-account quota exceeded — no further requests until the quota window resets${retryAfter ? ` (Retry-After: ${retryAfter}s)` : ''}${spotifyMsg ? ` — ${spotifyMsg}` : ''}`,
          retryAfter,
          reason,
        );
      }

      // On a retried attempt (e.g. immediately after a 401-refresh, or on the
      // single re-queued attempt a throttle earns) we have already consumed
      // our retry budget, so a 429 here is definitive: throw with
      // retryAfterSec attached rather than re-queueing again, which would loop
      // forever against a stubborn 429 (#671).
      if (retryCount > 0) {
        throw new SpotifyApiError(
          429,
          `Rate limited — Retry-After ${retryAfter}s${spotifyMsg ? ` — ${spotifyMsg}` : ''}`,
          retryAfter,
          reason,
        );
      }

      if (retryAfter > RETRY_SLEEP_CAP_SEC) {
        // Too long to wait on: fail fast with the wait time. _rateLimitUntil
        // already parks every later launch at the gate until the window
        // passes, and the streak breaker turns a repeat into an immediate
        // answer rather than another wait.
        throw new SpotifyApiError(
          429,
          `Rate limited — Retry-After ${retryAfter}s exceeds the in-queue wait cap (${RETRY_SLEEP_CAP_SEC}s); retry later.`,
          retryAfter,
          reason,
        );
      }

      this._lastThrottle = { retryAfterSec: retryAfter, waitedMs: retryAfter * 1000, at: throttledAt };
      // Hand the attempt back to the scheduler instead of sleeping here
      // (#892). The cooldown set above IS the gate; the re-queued attempt
      // reserves a slot behind every other queued task, so the process waits
      // out this one window rather than this task stalling the funnel while
      // every other caller pays its own copy of the same wait. The scheduler
      // re-runs the same body with `attempts + 1`, so the single retry this
      // budget allows is still the single retry the task gets.
      throw new ThrottleRetry(retryAfter);
    }

    // Gateway/upstream failures (#675). Spotify answered, which means it
    // rejected the request rather than acting on it, so a re-send is safe even
    // for a mutation — unlike the transport path above, where we never got an
    // answer. The wait stays inside the queue; the attempt count is what
    // bounds this, so a permanently unhealthy Spotify cannot turn one tool
    // call into an unbounded stall. `_rateLimitUntil` is deliberately left
    // alone: a 5xx cooldown is per-request, and arming the shared quota
    // window on it would block every queued call behind one flaky route.
    if (RETRYABLE_STATUSES.has(res.status) && retryCount + 1 < MAX_ATTEMPTS) {
      const serverWait = res.headers.get('Retry-After');
      // A `Retry-After` here is Spotify naming its own cooldown, so it wins
      // over our computed backoff; without one we use jittered exponential
      // backoff, which is what stops N processes on one developer account
      // from retrying in lockstep.
      const requestedMs = serverWait === null
        ? this.backoffDelayMs(retryCount)
        : parseRetryAfter(serverWait) * 1000;
      if (requestedMs > RETRY_SLEEP_CAP_SEC * 1000) {
        // Beyond the in-queue cap. Fail fast rather than park the queue, and
        // never report a short wait when the server named a long one.
        throw new SpotifyApiError(
          res.status,
          `Spotify answered ${res.status} with Retry-After ${Math.round(requestedMs / 1000)}s — `
            + `above the ${RETRY_SLEEP_CAP_SEC}s in-queue wait cap; retry later.`,
        );
      }
      await sleep(requestedMs);
      return this.rawRequest(method, url, body, retryCount + 1, contentType, conditional, signal);
    }

    // 304 Not Modified is a successful conditional read, not a failure: the
    // caller holds the payload this ETag identifies. Returned before the
    // !res.ok mapping below, whose body-less 304 would be read as an error and
    // reported as one.
    if (res.status === 304) return res;

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
          message =
            res.status === 404 && isNoActiveDevice404(spotifyMsg)
              ? noActiveDeviceMessage(url)
              : reason
                ? `${spotifyMsg} (reason: ${reason})`
                : spotifyMsg;
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

  async get<T>(path: string, params?: Record<string, string>, opts?: GetOptions): Promise<T | null> {
    // Resolved at the public entry point, in the caller's async context, and
    // carried explicitly from here on. The enqueued task below runs under the
    // scheduler's context, so an ambient read down there would be the wrong
    // request's signal (#676).
    const signal = opts?.signal ?? currentRequestSignal();
    // A read whose caller has already gone must not reach the cache, the
    // token refresh, or the queue: it would be a result nobody will read,
    // served from a warm entry that the walk's cancellation cannot reclaim.
    if (signal?.aborted) throw cancelledError('GET', path);
    const url = this.buildUrl(path, params);
    // TTL cache for immutable catalog reads (#54): keyed on the API-relative
    // URL, whose query params cacheKey sorts by name then value (#678), so an
    // inline query and a params object in any order share one entry; volatile
    // paths (/me/player*, /me/top*, recently-played) bypass.
    const relative = url.startsWith(BASE_URL) ? url.slice(BASE_URL.length) : url;
    const cacheable = this.cache !== null && !shouldBypassCache('GET', relative);
    // The same key indexes the ETag validator store, which serves volatile
    // paths too: a 304 there means "unchanged", and the stored payload the
    // ETag identifies is the answer (#601). Only its freshness is never
    // assumed — it is returned only after the origin confirms it.
    const key = cacheKey('GET', relative);
    // The world as of before this request goes out (#893). If a mutation
    // invalidates anything while the request is in flight, this body is a
    // pre-mutation snapshot and must not be written into shared state — see
    // `_invalidationEpoch`.
    const epochAtRequest = this._invalidationEpoch;
    if (cacheable) {
      const hit = this.cache!.get(key);
      if (hit !== undefined) return hit as T;
    }
    const validator = this.validators?.get(key);
    let servedFrom304 = false;
    let responseEtag: string | null = null;
    const result = await this.enqueue(
      async (attempts) => {
        // The re-queued attempt re-enters the queue, so a body that only reads
        // these out-of-band flags could report the PREVIOUS attempt's 304.
        // Reset at the top of every run: the flags describe the attempt that
        // produced the result this run is about to return.
        servedFrom304 = false;
        responseEtag = null;
        const res = await this.rawRequest(
          'GET',
          url,
          undefined,
          attempts,
          undefined,
          validator ? { ifNoneMatch: validator.etag } : undefined,
          signal,
        );
        if (res.status === 304) {
          // A 304 with no stored validator cannot be answered: the request
          // carried no If-None-Match, so the payload this names was never
          // held. Report it rather than inventing an empty result. The reason
          // rides along so the host sees WHICH failure this is — an origin
          // answering a conditional-cache contract violation — instead of a
          // bare internal_error it could not act on (#601).
          if (!validator) {
            throw new SpotifyApiError(
              304,
              `GET ${url} answered 304 Not Modified but no stored ETag backs it — ` +
                'the request carried no If-None-Match, so there is no payload to serve',
              undefined,
              'NOT_MODIFIED_WITHOUT_VALIDATOR',
            );
          }
          servedFrom304 = true;
          // A 304 is a cache hit: refresh the payload TTL and the validator
          // window so the next read revalidates against the same ETag. The
          // payload is the same object, so its measured size is still
          // recorded and the byte budget keeps charging it exactly once.
          //
          // Epoch-guarded like the store below (#893): a 304 answers "this
          // body is unchanged", which is only true of the world the validator
          // was taken from. A mutation that landed mid-request makes the
          // "unchanged" claim refer to the past.
          if (!this.invalidatedSince(epochAtRequest, key)) {
            if (cacheable) this.cache!.set(key, validator.value, { bytes: this.bodyBytes(validator.value) });
            this.validators?.set(key, validator.value, validator.etag);
          }
          opts?.onNotModified?.();
          return validator.value as T;
        }
        responseEtag = res.headers.get('etag');
        if (res.status === 204) return null;
        // Read as text, not via res.json(), so the exact wire size of the
        // body is available for the cache's byte budget (#894) without
        // serializing the parsed value a second time.
        const text = await res.text();
        let parsed: T;
        try {
          parsed = JSON.parse(text) as T;
        } catch (err) {
          if (err instanceof SyntaxError) {
            // Body was not valid JSON. The body is already drained by the
            // read above, so the connection can be reused; fail with an
            // actionable error rather than a parse stack.
            throw new SpotifyApiError(res.status, `GET ${path} returned a non-JSON body`);
          }
          throw err;
        }
        this.noteBodyBytes(parsed, Buffer.byteLength(text, 'utf8'));
        return parsed;
      },
      opts?.priority,
      // The SAME signal resolved at the top of this method. `enqueue` defaults
      // to the ambient request signal, which is right for a bare call but
      // wrong here: a caller that passed an explicit `signal` (a direct
      // client caller, or a walk page) would have its task judged against
      // whatever ambient context happened to exist instead, and a task parked
      // in the lane could not be dropped when that signal fired (#676).
      signal,
    );
    if (servedFrom304) return result;
    // Do not write a body into shared state if anything that could have
    // changed THIS key was invalidated while the request was in flight (#893).
    // Without this, a read issued before a mutation re-seeds the entry that
    // mutation dropped, and the stale body is then served from cache for the
    // full TTL while looking perfectly fresh. The scope is the plan's own
    // prefixes (#1249), so a write that drops none of them — a player command,
    // which is the whole point of scoping — no longer discards a catalog read
    // that merely overlapped it. The caller still gets `result`: a truthful
    // answer to the read it made; only the shared-state write is withheld.
    if (this.invalidatedSince(epochAtRequest, key)) return result;
    if (cacheable && result !== null) {
      this.cache!.set(key, result, { bytes: this.bodyBytes(result) });
      this._persist?.scheduleSave(this.cache);
    }
    // A body that no longer carries an ETag supersedes any stored validator:
    // keeping the old one would offer a tag whose payload we just replaced.
    if (responseEtag && result !== null) this.validators?.set(key, result, responseEtag);
    else this.validators?.delete(key);
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
   *
   * The returned array is silently capped. A caller that must REPORT that
   * (#864 — no "all clear" verdict off a partial scan) uses
   * `getAllPagesWithTruncation`; this method keeps the bare-array signature
   * the ~35 callers that do not report truncation depend on.
   */
  async getAllPages<T>(
    path: string,
    params?: Record<string, string>,
    opts?: GetAllPagesOptions,
  ): Promise<T[]> {
    return (await this.getAllPagesWithTruncation<T>(path, params, opts)).items;
  }

  /**
   * `getAllPages` plus the truncation verdict for THIS walk (#864).
   *
   * The verdict is RETURNED, never stored on the client. The MCP SDK
   * dispatches `tools/call` without awaiting — protocol.js fires
   * `_onrequest` straight from the transport onmessage — so two
   * overlapping calls interleave their awaits on ONE shared client and a
   * stored flag would answer with whichever walk finished last, not the walk
   * the caller just made.
   *
   * `truncated` says rows are missing; `truncatedByCap` says the cap is WHY
   * (#718). They differ: a walk that ends on a short page while the server's
   * own `total` still counts more rows is short of the data without the cap
   * ever binding it, and a caller that reports "truncated at the cap" there
   * blames a ceiling that did not apply. `reportedTotal` is the server's own
   * count, or null when it sent none — never the walked count.
   *
   * `pages` is how many paged read requests this walk issued (#899) — one per
   * page, counted at the point the request fires rather than derived from the
   * row total, because a walk that ends on a short page or hits the cap reads
   * fewer rows than pages it spent. A composite read that walks N sources has
   * a real, quota-bearing cost, and a tool that reports the rows without the
   * request count leaves the caller unable to tell a 2-request answer from a
   * 250-request one.
   *
   * It counts LOGICAL page reads, not bytes on the wire: a 401-refresh or 429
   * backoff retry inside `get` re-sends one page and still counts once, and a
   * TTL-cached page issues no HTTP at all but is counted as a page because the
   * walk did ask for it. The figure is "how many page reads this walk
   * performed", which is the number a caller can act on; a raw socket count is
   * not reproducible from a tool response.
   */
  async getAllPagesWithTruncation<T>(
    path: string,
    params?: Record<string, string>,
    opts?: GetAllPagesOptions,
  ): Promise<{ items: T[]; truncated: boolean; truncatedByCap: boolean; reportedTotal: number | null; pages: number }> {
    const maxItems = opts?.maxItems ?? this.fetchAllCap;
    // Resolved ONCE, here at the walk's entry, for the reason given on
    // `rawRequest`: this method runs in the CALLER's async context, and every
    // page it issues must be judged against the same signal. Re-reading the
    // ambient store per page would work, but pinning it also means a walk
    // cannot silently switch cancellation sources halfway through (#676).
    const signal = opts?.signal ?? currentRequestSignal();
    const all: T[] = [];
    let offset = opts?.initialOffset ?? 0;
    // #864: a bare array cannot distinguish "read everything" from "stopped at
    // the cap", so the verdict travels with the result rather than on the
    // client.
    // Monotonic per-walk id; index.ts forwards it as the MCP progressToken.
    const walkId = ++this.walkCounter;
    let pageNumber = 0;
    // #899: HTTP GETs this walk issued. Independent of `pageNumber`, which only
    // advances when a progress reporter is installed and so counts NOTHING on
    // an ordinary install. Incremented before the `break` below, because a
    // request that returned no page array was still spent against the quota.
    let requests = 0;
    // Loop bound is the server-reported total when present; otherwise walk
    // until a short page signals the end. maxItems caps iterations too.
    // The last total the server reported, so the end-of-data return below can
    // be reconciled against it (#718).
    let lastTotal: number | null = null;
    for (;;) {
      const pageParams = { ...params, offset: String(offset) };
      // #133: walk pages enqueue at LOW priority so interactive reads
      // always drain first.
      //
      // The between-pages cancellation boundary (#676) is enforced at the top
      // of `get`, which every page goes through, and which refuses BEFORE the
      // URL is built and before the request is enqueued. That is the same
      // boundary this loop would draw if it checked here itself: a signal
      // arriving while page N is in flight stops the walk before page N+1 is
      // requested, with page N fully committed to `all` and no half-written
      // page left behind. A second check in the loop was tried and removed —
      // it was unreachable as a distinct behaviour, so the walk now carries
      // one enforcement point rather than two that could drift apart.
      const page = await this.get<SpotifyPaged<T>>(path, pageParams, { priority: 'low', signal });
      requests++;
      if (!page || !Array.isArray(page.items)) break;
      if (typeof page.total === 'number') lastTotal = page.total;
      all.push(...page.items);
      // One page event, fanned out to the process-wide reporter and to the
      // caller's own hook (#902). Both are best-effort: a throwing one must
      // never break a walk.
      const progress: PageProgress = {
        walkId,
        page: ++pageNumber,
        fetched: all.length,
        ...(typeof page.total === 'number' ? { total: page.total } : {}),
      };
      const reporter = this.progressReporter;
      if (reporter !== null) {
        try {
          reporter(progress);
        } catch {
          // Progress is best-effort; a throwing reporter must never break a walk.
        }
      }
      const onPage = opts?.onPage;
      if (onPage) {
        try {
          onPage(progress);
        } catch {
          // Same contract as the global reporter.
        }
      }
      if (all.length >= maxItems) {
        // The cap bit. It only TRUNCATED something if rows really are missing:
        // either the slice dropped overflow the page had already delivered, or
        // the server's `total` says the walk stopped short of the end. An
        // endpoint that reports no total gives us nothing to prove
        // completeness against, so that case stays conservatively truncated.
        return {
          items: all.slice(0, maxItems),
          truncated:
            all.length > maxItems
            || typeof page.total !== 'number'
            || all.length < page.total,
          // The cap is what ended this walk, so it is what the verdict is
          // attributed to even when rows also remain beyond the total.
          truncatedByCap: true,
          reportedTotal: lastTotal,
          pages: requests,
        };
      }
      const limit = typeof page.limit === 'number' && page.limit > 0 ? page.limit : page.items.length;
      offset += limit;
      if (page.items.length === 0 || page.items.length < limit) break;
      if (typeof page.total === 'number' && offset >= page.total) break;
    }
    // The loop ended on a short page, not on the cap. That is the normal
    // end-of-data signal, but the server's own `total` outranks it (#718): if
    // it says more rows exist than the walk collected, a short page did NOT
    // mean the end, and "complete" would assert a completeness nobody checked.
    // A total nobody reported stays unknown, so it cannot manufacture a
    // truncation — and it must not silence one either.
    return {
      items: all,
      truncated: lastTotal !== null && all.length < lastTotal,
      // The cap never bound this walk — it ended on the data's own terms, so
      // any truncation here is the server's total saying rows remain.
      truncatedByCap: false,
      reportedTotal: lastTotal,
      pages: requests,
    };
  }

  /**
   * Parse a successful mutation body as JSON, or null when there is nothing to
   * parse (204) or nothing parseable to read. Non-JSON bodies are drained so
   * the connection can be reused.
   *
   * Never throws. A 2xx on a write means Spotify applied it, so an unreadable
   * body is a lost RESPONSE, not a failed MUTATION — and reporting it as a
   * failure invites the caller to retry a write that already landed (queue
   * duplicates, double playlist adds, duplicate library saves, #674). The
   * pre-fix guard covered only a non-JSON content-type, so a 200 that declared
   * JSON and then delivered an empty or torn body escaped as a raw
   * SyntaxError from a client method.
   *
   * The read path (`get`) still fails loudly on an unparseable body, and the
   * asymmetry is deliberate: there, null is a real answer meaning "204, nothing
   * here", so an unreadable body must not be laundered into one.
   */
  private async jsonOrNull<T>(res: Response): Promise<T | null> {
    if (res.status === 204) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // endpoint returns a non-JSON payload (e.g. queue ID as text/plain).
      // Drain it so the connection can be reused; a body we already decided
      // not to read failing to drain changes nothing about the write.
      await res.text().catch(() => undefined);
      return null;
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      // The body stream died part-way. The write reached Spotify either way.
      return null;
    }
    // A 200 with a JSON content-type and no body is how several Spotify
    // mutations answer; there is nothing to parse and nothing to report.
    if (text.trim().length === 0) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Declared JSON, delivered something else — truncated mid-flight, or an
      // HTML page from an intermediary. Nothing in the body distinguishes
      // "the response was cut off" from "the response was never really this
      // write's", and guessing wrong in the direction of failure is the one
      // that double-applies a completed mutation. So the payload is reported
      // as absent and the write is left standing.
      return null;
    }
  }

  /**
   * Send one mutating request and do the post-write bookkeeping (#54/#64/#674).
   *
   * The bookkeeping runs inside the queue task, immediately after Spotify
   * accepted the write and BEFORE its body is read. That ordering is the
   * point: a write that landed is a fact about the server whether or not the
   * response can be parsed, so cache invalidation and the history line must
   * not sit downstream of the parse. They used to, and an unreadable body
   * therefore both reported a completed mutation as failed AND left a stale
   * read cache plus an audit trail with a hole where the mutation was.
   *
   * A rejected write (`rawRequest` throwing — 401, 404, 429 after retries) is
   * deliberately NOT counted as one: nothing was mutated, so there is nothing
   * to invalidate and nothing to record.
   */
  private async mutate<T>(method: string, path: string, url: string, body?: unknown): Promise<T | null> {
    // Writes are cancellable on the same terms as reads (#676). The signal is
    // resolved here, in the caller's context, for the same reason: the task
    // body below is dispatched by the scheduler, not by the caller.
    const signal = currentRequestSignal();
    return this.enqueue(async (attempts) => {
      const res = await this.rawRequest(method, url, body, attempts, undefined, undefined, signal);
      let parsed: T | null = null;
      try {
        parsed = await this.jsonOrNull<T>(res);
        return parsed;
      } finally {
        // `parsed` is null when the body was unreadable; the invalidation and
        // the history line still run, and the snapshot_id rides along whenever
        // the body did parse.
        this.afterMutation(method, path, parsed);
      }
    });
  }

  async post<T>(path: string, body?: unknown): Promise<T | null> {
    return this.mutate<T>('POST', path, this.buildUrl(path), body);
  }

  async put<T>(path: string, body?: unknown): Promise<T | null> {
    return this.mutate<T>('PUT', path, this.buildUrl(path), body);
  }

  /**
   * PUT a raw string body (used for cover image uploads) with an explicit
   * Content-Type. Goes through the same rate-limited queue,
   * token-refresh and retry handling as put().
   */
  async putRaw(path: string, body: string, contentType = 'image/jpeg'): Promise<void> {
    const url = this.buildUrl(path);
    const signal = currentRequestSignal();
    await this.enqueue((attempts) => {
      // No response body to read: the request carried image bytes and the
      // answer is a bodiless 202. Bookkeeping sits directly after the request
      // for the same reason it does in mutate() (#674).
      return this.rawRequest('PUT', url, body, attempts, contentType, undefined, signal);
    });
    this.afterMutation('PUT', path, null);
  }

  async delete<T>(path: string, body?: unknown): Promise<T | null> {
    return this.mutate<T>('DELETE', path, this.buildUrl(path), body);
  }
}

/**
 * Pre-flight gate for heavy composite scans (#904). Reads the shared
 * cooldown through the existing getRateLimitStatus() accessor: when a
 * cooldown is active the caller returns `message` verbatim and issues zero
 * requests instead of fanning out. Clients without the accessor (older
 * stubs) report no cooldown, so their budgets apply unchanged.
 */
export function quotaPreflight(client: SpotifyClient): { blocked: boolean; waitSec: number; message: string } {
  let waitMs = 0;
  try {
    waitMs = client.getRateLimitStatus?.()?.cooldownRemainingMs ?? 0;
  } catch {
    waitMs = 0;
  }
  if (!(waitMs > 0)) return { blocked: false, waitSec: 0, message: '' };
  const waitSec = Math.ceil(waitMs / 1000);
  return {
    blocked: true,
    waitSec,
    message:
      `Rate-limit cooldown active — wait ~${waitSec}s before heavy scans (cooldownRemainingMs=${Math.round(waitMs)}ms). `
      + 'Issued 0 requests; scan budget held. Retry after the quota window resets.',
  };
}

/** Request-count snapshot before a scan (#904): null when the client does not expose counters. */
export function quotaSnapshot(client: SpotifyClient): number | null {
  let total: unknown;
  try {
    total = client.getRateLimitStatus?.()?.requestsTotal;
  } catch {
    return null;
  }
  return typeof total === 'number' ? total : null;
}

/**
 * Recency horizon for quota pressure (#904): a throttle older than this no
 * longer shrinks scan budgets — the window has recovered.
 */
const QUOTA_PRESSURE_MS = 5 * 60_000;

/**
 * Remaining scan budget inside the trailing quota window (#904). When the
 * client throttled recently (but the cooldown has since expired) heavy scans
 * shrink to what's left of the window instead of their module-local
 * constant. With no recent throttle pressure the window is unbounded, so
 * today's budgets apply exactly as before.
 */
export function quotaWindowRemaining(client: SpotifyClient): number {
  let status: RateLimitStatus | undefined;
  try {
    status = client.getRateLimitStatus?.();
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
  if (!status || status.lastThrottleAt == null) return Number.MAX_SAFE_INTEGER;
  if (Date.now() - status.lastThrottleAt > QUOTA_PRESSURE_MS) return Number.MAX_SAFE_INTEGER;
  const spent = status.requestsLastMinute ?? 0;
  return Math.max(1, getConfig().fetchAllCap - spent);
}

/**
 * `requests_made` fragment for scan payloads (#904): the delta since
 * `before`, or an empty object when counters are unavailable so stub-backed
 * payload shapes stay byte-identical.
 */
export function quotaDelta(
  client: SpotifyClient,
  before: number | null,
): { requests_made: number } | Record<string, never> {
  if (before === null) return {};
  const after = quotaSnapshot(client);
  return after === null ? {} : { requests_made: after - before };
}
