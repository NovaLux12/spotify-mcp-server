/**
 * Bounded-concurrency fan-out for the freshness-radar walks (#783).
 *
 * `show_new_episodes`, `check_artist_releases`, `artist_release_digest` and
 * `search_deep` each fan out one awaited request per show / artist / search
 * type from a serial loop, so a default-budget scan paid 25+ round trips back
 * to back and the tool's wall clock was RTT x items no matter how the machine
 * was loaded. `mapLimit` runs the same work with at most `limit` requests in
 * flight and returns the results **index-aligned with the input**, so what a
 * caller renders and what it persists is a function of its input rather than
 * of which request happened to settle first.
 *
 * ## What the bound is, and what it deliberately is not
 *
 * This is a *tool-side* bound on how many `client.get` calls one handler has
 * outstanding at once. It is not a rate limiter and adds no requests:
 *
 *  - A 429 is never retried here. Whatever stops the caller — a quota wall, a
 *    burst limit, a dead token — is the caller's own `shouldStop`, and it stops
 *    *scheduling* new work. Requests already in flight are left to settle
 *    because they are already sent; discarding their answers would throw away
 *    rows the caller paid for. Nothing in this file waits on `Retry-After` and
 *    nothing spins (§1 rate limiting).
 *  - A bounded fan-out does not make a 25-item scan cheaper. The request count
 *    is identical; only the shape of the wait changes, and the honest claim is
 *    "overlapped", not "faster" — see the note on the request funnel below.
 *
 * ## Relationship to the request funnel (#892)
 *
 * #892 (PR #1206) LANDED. The client's single serial drain is now a
 * bounded-concurrency funnel under `SPOTIFY_MCP_MAX_CONCURRENCY` (its default 3,
 * its own hard ceiling 32) plus a shared rate-limit gate and a
 * consecutive-throttle breaker. The two states this section used to hold open
 * have collapsed into the second, and the disclosure has to be restated for it:
 *
 *  - **While the drain was serial**, `SpotifyClient` released one request at a
 *    time with a minimum inter-request gap, so this helper overlapped the
 *    *handler's* awaits without overlapping any wire traffic. The wall-clock
 *    win was bounded by what the drain permitted, and the honest claim for a
 *    25-item scan was that the handler stops idling between round trips — not
 *    that the wire is faster.
 *  - **Now that the funnel is concurrent**, "this overlaps handler awaits" is no
 *    longer true at all: both limiters bound the same quantity, so a scan's
 *    width is resolved *against* the funnel's rather than beside it, and the
 *    number that actually bound it is the one `mapLimit` was handed.
 *
 * Two independent limiters do not add, they multiply: the narrower one wins,
 * silently, and the effective width becomes a function of two tunables no
 * operator can see at once. So the width is resolved by
 * `resolveFanoutConcurrency`, which reads the funnel's `SPOTIFY_MCP_MAX_CONCURRENCY`
 * FIRST and falls back to this tool's own `SPOTIFY_MCP_FANOUT_CONCURRENCY`
 * only when the funnel knob is unset. The two therefore agree by construction,
 * and `fanout_concurrency` in the payload reports whichever knob actually
 * supplied the number rather than a value that is merely plausible.
 *
 * What is genuinely NOT redundant with the funnel, and why this helper stays:
 *
 *  - The funnel bounds requests in flight. It has no notion of a scan that has
 *    decided to stop, so it cannot implement `shouldStop`: on a 429 the
 *    remaining 20 shows would still be scheduled and sent. `mapLimit` consults
 *    the gate before each item starts, which is the whole of the quota
 *    short-circuit #783 asks to preserve.
 *  - `Promise.all` over a 25-item list is not a substitute either. It schedules
 *    all 25 at once, and once the funnel is concurrent that is a scan taking
 *    every permit an interactive read could have used. A tool-side width is
 *    what lets one bulk scan be a good citizen of a shared funnel.
 *
 * If #892 later grows a stop-scheduling gate of its own, revisit this file
 * then; until it does, the two concerns are genuinely different and the width
 * is shared rather than duplicated.
 */

/** One slot per input item, in input order. `undefined` = never ran, or threw. */
export type MapLimitResults<R> = Array<R | undefined>;

export interface MapLimitError {
  /** Index of the input that failed — the same index its result slot would have. */
  index: number;
  error: unknown;
}

export interface MapLimitOptions {
  /**
   * Consulted before each item is started, including the first. Returning true
   * ends the run with the remaining items unstarted; in-flight items still
   * settle and keep their results.
   *
   * This is the hook the radar scans use to stop on a 429 / 401 rather than
   * spend the rest of the budget on requests that cannot succeed. It is a
   * *scheduling* gate: it never cancels anything already sent.
   */
  shouldStop?: () => boolean;
}

export interface MapLimitOutcome<R> {
  /** Index-aligned with `items`. A slot is `undefined` if the item never ran or its `fn` rejected. */
  results: MapLimitResults<R>;
  /** Every rejection, in the order it was observed. Never rethrown by this helper. */
  errors: MapLimitError[];
  /** How many items were actually started. Less than `items.length` once `shouldStop` fired. */
  started: number;
  /** How many started items settled without throwing. */
  succeeded: number;
  /** True when `shouldStop` ended the run before every item was started. */
  stoppedEarly: boolean;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight, results aligned
 * to input order.
 *
 * Rejections are **collected, not rethrown**: every caller here has a policy
 * that differs (a quota wall ends the scan, a 404 on one stale id is recorded
 * and the scan continues — #772), so classifying inside the helper would have
 * to know more about the caller than it should. A caller that wants the old
 * "first error propagates" behaviour rethrows the first entry of `errors`.
 *
 * `limit` is floored at 1: a zero or negative width must still make progress
 * rather than silently return an empty result, because an empty result from a
 * fan-out reads as "the scan found nothing".
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options: MapLimitOptions = {},
): Promise<MapLimitOutcome<R>> {
  // Dense, not `new Array(n)`: a sparse hole and an explicit `undefined` are
  // the same value but not the same array, and a caller mapping or spreading
  // the results would skip one and not the other.
  const results: MapLimitResults<R> = Array.from({ length: items.length }, () => undefined);
  const errors: MapLimitError[] = [];
  const width = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  const shouldStop = options.shouldStop;

  let next = 0;
  let started = 0;
  let succeeded = 0;
  let stoppedEarly = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (shouldStop?.()) {
        stoppedEarly = true;
        return;
      }
      if (next >= items.length) return;
      const index = next++;
      started++;
      try {
        const value = await fn(items[index] as T, index);
        results[index] = value;
        succeeded++;
      } catch (error) {
        errors.push({ index, error });
      }
    }
  };

  // Start at most `width` workers; each pulls the next index as it frees up, so
  // the in-flight count never exceeds the width and a short list never spawns
  // workers that have nothing to do.
  const workers: Array<Promise<void>> = [];
  for (let i = 0, n = Math.min(width, items.length); i < n; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { results, errors, started, succeeded, stoppedEarly };
}
