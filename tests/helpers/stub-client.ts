/**
 * The one shared stub client for the tool suite (#659).
 *
 * ## Why this exists
 *
 * Before this file, ~19 test files each hand-copied `SpotifyClient.getAllPages`
 * into their own fake client. Sixteen of them hardcoded `const maxItems =
 * opts?.maxItems ?? 500` — a literal that silently diverged from the real
 * client's `getConfig().fetchAllCap`, so a test could assert "the cap is 500"
 * while production honoured `SPOTIFY_MCP_FETCH_ALL_CAP` and a test could
 * exercise a cap that production never applies. Nine supported `initialOffset`
 * and ten did not; some stopped on a short page, one stopped on `!page.next`;
 * two seeded the cursor from `params.offset` rather than `opts.initialOffset`.
 * The copies were not equivalent implementations, they were a family of
 * implementations, and nothing kept them equivalent to the one they claimed to
 * mirror.
 *
 * That is the failure mode AGENTS.md §6 names: **a correctly named field can
 * still lie about its value.** A stub that reimplements the code under test
 * cannot catch a regression in that code, because the regression has to be made
 * in the copy to be visible — and nobody edits a copy on purpose. #236 shipped a
 * silent truncation bug through exactly this shape.
 *
 * ## The design rule
 *
 * **`StubSpotifyClient` extends the real `SpotifyClient` and overrides only the
 * five methods that touch the network.** `getAllPages`,
 * `getAllPagesWithTruncation`, and every other paging behaviour are INHERITED —
 * there is exactly one implementation of the walk in this repo and it is the
 * production one. A change to `getAllPages`' cap, its malformed-page break, its
 * `initialOffset` handling, or its truncation verdict is therefore a change
 * every test in this suite sees, with no copy to update and none to forget.
 *
 * The corollary is the reason a permissive stub is dangerous here: a stub
 * answers an unexpected call with a plausible default (`null`, `[]`, `{}`),
 * which means **a call the test never anticipated still passes**. A tool that
 * starts reading the wrong endpoint, or starts sending an argument nobody
 * registered, gets a well-formed empty answer and the assertion that was
 * supposed to catch it never runs. So this stub is strict by construction:
 *
 * - An **unregistered path** throws {@link UnexpectedCallError} naming the call
 *   and listing what IS registered. It does not return `null`.
 * - A **registered path called with the wrong argument** can be caught with
 *   {@link Route.expectParams} / {@link Route.expectBody}, which assert the
 *   argument the production code actually sent — so a dropped query parameter
 *   (the `async get(path: string)` bug in the old stubs) is a test failure
 *   rather than an invisible no-op.
 * - An **unexpected method** on a registered path throws the same way.
 *
 * `undefined` is still answerable, because some endpoints genuinely 204 — ask
 * for it explicitly with `respond: () => undefined` rather than getting it by
 * accident.
 *
 * ## What it deliberately does not do
 *
 * It does not stub `globalThis.fetch`. Going through the real HTTP layer would
 * mean a token file, the retry/429 queue, and the cache — none of which a tool
 * test is trying to exercise, and all of which need a real `SPOTIFY_MCP_TOKEN_FILE`
 * under a temp dir. Overriding the five terminal methods keeps the test at the
 * layer where tool bugs live while leaving the *paging algorithm* real, which is
 * the part that was being reimplemented.
 *
 * Every read still records `(method, path, arg)` so a test can assert the
 * request it expected to be made, and the recorded `arg` is the argument
 * production actually passed — never a value the stub reconstructed.
 *
 * @see tests/stub-client.test.ts — the helper's own contract tests.
 */

import { SpotifyClient } from '../../src/client.js';
import type { GetAllPagesOptions, GetOptions } from '../../src/client.js';
import type { SpotifyPaged, PlaylistItemObject, SpotifyImage } from '../../src/types/spotify.js';

/** HTTP verbs a {@link StubSpotifyClient} records. `PUT_RAW` is a distinct
 *  method because the cover-art upload carries a raw body plus an explicit
 *  Content-Type, and collapsing it into `PUT` is how those two arguments got
 *  lost in the first place. */
export type StubMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PUT_RAW';

/** One recorded request, exactly as production issued it. */
export interface StubCall {
  method: StubMethod;
  /** Path as passed to the client method — no query string is synthesised. */
  path: string;
  /**
   * The argument the caller passed: the query params for `GET`, the body for
   * `POST`/`PUT`/`DELETE`, the raw string for `PUT_RAW`. `undefined` when the
   * caller passed nothing. Never reconstructed by the stub.
   */
  arg?: unknown;
  /** `PUT_RAW`'s Content-Type, the one argument the five-verb shape would lose. */
  extra?: unknown;
}

/**
 * Thrown when the code under test calls a path (or a verb on a path) that the
 * test never registered.
 *
 * The message names the offending call AND lists the registered routes,
 * because the failure is nearly always "the tool now reads an endpoint the
 * test has not been taught about" — which is a finding, not a nuisance, and is
 * exactly the regression a permissive `return null` would have hidden.
 */
export class UnexpectedCallError extends Error {
  readonly call: StubCall;
  readonly registered: string[];

  constructor(call: StubCall, registered: string[]) {
    const known = registered.length > 0 ? registered.join(', ') : '(none)';
    super(
      `StubSpotifyClient: no route for ${call.method} ${call.path}` +
        (call.arg === undefined ? '' : ` with arg ${safeJson(call.arg)}`) +
        `\n  Registered routes: ${known}` +
        `\n  This is a strict stub on purpose (#659): a permissive one would` +
        `\n  answer this call with a plausible default and let the assertion` +
        `\n  that should have caught it pass. Register the route if the call` +
        `\n  is correct, or fix the caller if it is not.`,
    );
    this.name = 'UnexpectedCallError';
    this.call = call;
    this.registered = registered;
  }
}

/** Thrown when a registered route's argument expectation is not met. */
export class UnexpectedArgumentError extends Error {
  constructor(method: StubMethod, path: string, detail: string) {
    super(`StubSpotifyClient: ${method} ${path} received an unexpected argument — ${detail}`);
    this.name = 'UnexpectedArgumentError';
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A responder: given the recorded call, produce the reply. */
export type StubResponder<T = unknown> = (call: StubCall) => T | Promise<T>;

/** Options for {@link StubSpotifyClient.route}. */
export interface Route<T = unknown> {
  /**
   * Subset of the query params / body the caller MUST have sent. Asserted on
   * the real argument, so a parameter the production code stopped forwarding
   * fails here instead of vanishing.
   */
  expectParams?: Record<string, unknown>;
  /**
   * Keys that must be ABSENT from the argument. For pinning "this endpoint was
   * not called" in a body, and for rejecting a parameter a regression would add.
   */
  rejectParams?: string[];
  /** Reply. A function is called per request; a value is returned as-is. */
  respond: StubResponder<T> | T;
  /**
   * How many times this route may be called. A number is an exact count; an
   * object sets bounds. Exceeding it throws, which is how a test pins that a
   * write happened exactly once instead of merely that it happened.
   */
  times?: number | { min?: number; max?: number };
}

interface RegisteredRoute {
  method: StubMethod;
  path: string;
  /** Exact string, or a predicate for paths with ids in them. */
  match: (path: string) => boolean;
  route: Route;
  hits: number;
}

function compileMatcher(path: string | RegExp): (path: string) => boolean {
  if (path instanceof RegExp) return (p) => path.test(p);
  return (p) => p === path;
}

function matchesCount(spec: number | { min?: number; max?: number }, hits: number): string | null {
  if (typeof spec === 'number') return hits === spec ? null : `expected exactly ${spec} call(s), saw ${hits}`;
  const { min, max } = spec;
  if (min !== undefined && hits < min) return `expected at least ${min} call(s), saw ${hits}`;
  if (max !== undefined && hits > max) return `expected at most ${max} call(s), saw ${hits}`;
  return null;
}

function describeArg(arg: unknown): Record<string, unknown> | null {
  // Only plain objects are inspectable key-by-key; a raw string body (PUT_RAW)
  // is asserted with `respond` instead.
  if (arg === null || typeof arg !== 'object' || Array.isArray(arg)) return null;
  return arg as Record<string, unknown>;
}

/**
 * A `SpotifyClient` whose network methods are routed, and whose PAGING is the
 * production implementation.
 *
 * Extends the real client on purpose — see the file header for why a
 * reimplementation cannot catch a regression in the thing it reimplements.
 */
export class StubSpotifyClient extends SpotifyClient {
  /** Every request, in order, with the argument production actually passed. */
  readonly calls: StubCall[] = [];
  private readonly routes: RegisteredRoute[] = [];

  /**
   * `disableCache` is on: the TTL cache and the validator store would answer
   * some reads from a previous call, which is real-client behaviour no tool
   * test is asserting and which makes failures depend on test order. The
   * inherited `getAllPages` does not consult the cache for its own state, so
   * nothing about the walk changes.
   */
  constructor(opts: { fetchAllCap?: number } = {}) {
    super({ disableCache: true, ...opts });
  }

  /**
   * Register the reply for one method+path.
   *
   * Routes are matched most-recently-registered first, so a test can override a
   * route its harness set up. Unregistered calls throw.
   */
  route<T = unknown>(
    method: StubMethod,
    path: string | RegExp,
    route: Route<T>,
  ): this {
    this.routes.unshift({
      method,
      path: path instanceof RegExp ? String(path) : path,
      match: compileMatcher(path),
      route: route as Route,
      hits: 0,
    });
    return this;
  }

  /** Shorthand for a `GET` route. */
  get_(path: string | RegExp, route: Route): this {
    return this.route('GET', path, route);
  }

  /** Shorthand for a `POST` route. */
  post_(path: string | RegExp, route: Route): this {
    return this.route('POST', path, route);
  }

  /** Shorthand for a `PUT` route. */
  put_(path: string | RegExp, route: Route): this {
    return this.route('PUT', path, route);
  }

  /** Shorthand for a `DELETE` route. */
  delete_(path: string | RegExp, route: Route): this {
    return this.route('DELETE', path, route);
  }

  /**
   * Register a paged `GET` route backed by an in-memory array.
   *
   * This is what replaces the hand-copied paging loops. It returns a real
   * `SpotifyPaged` envelope, so the INHERITED `getAllPages` walks it with the
   * real cap, the real short-page break and the real `total` handling — a
   * fixture of 10 items at the default page size takes one request, and the
   * walk's own loop decides that, not a copy of it.
   */
  page<T>(
    path: string | RegExp,
    items: T[],
    opts: { pageSize?: number; route?: Omit<Route, 'respond'>; total?: number } = {},
  ): this {
    const pageSize = opts.pageSize ?? 50;
    return this.route('GET', path, {
      ...opts.route,
      respond: (call) => {
        const arg = describeArg(call.arg);
        const offset = Number(arg?.offset ?? 0) || 0;
        // The walk passes the page size it asked for; honour it so a fixture
        // paginates the way the real endpoint would.
        const requested = Number(arg?.limit ?? 0);
        const size = Number.isFinite(requested) && requested > 0 ? requested : pageSize;
        const slice = items.slice(offset, offset + size);
        const body: SpotifyPaged<T> = {
          items: slice,
          total: opts.total ?? items.length,
          limit: size,
          offset,
          next: offset + size < items.length ? `offset=${offset + size}` : null,
        };
        return body;
      },
    });
  }

  /** Recorded calls, optionally filtered. */
  callsTo(method?: StubMethod, pathContains?: string): StubCall[] {
    return this.calls.filter(
      (c) => (method === undefined || c.method === method) && (pathContains === undefined || c.path.includes(pathContains)),
    );
  }

  /** Forget every recorded call and reset every route's hit count. */
  reset(): void {
    this.calls.length = 0;
    for (const r of this.routes) r.hits = 0;
  }

  /**
   * Assert every route's `times` expectation held. Call at the end of a test
   * that pinned call counts; a mismatch names the route and both numbers.
   */
  assertCallCounts(): void {
    for (const r of this.routes) {
      if (r.route.times === undefined) continue;
      const problem = matchesCount(r.route.times, r.hits);
      if (problem) {
        throw new Error(`StubSpotifyClient: ${r.method} ${r.path} — ${problem}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // The five network methods. Everything else is inherited.
  // -------------------------------------------------------------------------

  override async get<T>(path: string, params?: Record<string, string>, _opts?: GetOptions): Promise<T | null> {
    const call: StubCall = { method: 'GET', path, arg: params };
    return (await this.dispatch(call)) as T | null;
  }

  override async post<T>(path: string, body?: unknown): Promise<T | null> {
    const call: StubCall = { method: 'POST', path, arg: body };
    return (await this.dispatch(call)) as T | null;
  }

  override async put<T>(path: string, body?: unknown): Promise<T | null> {
    const call: StubCall = { method: 'PUT', path, arg: body };
    return (await this.dispatch(call)) as T | null;
  }

  override async delete<T>(path: string, body?: unknown): Promise<T | null> {
    const call: StubCall = { method: 'DELETE', path, arg: body };
    return (await this.dispatch(call)) as T | null;
  }

  override async putRaw(path: string, body: string, contentType?: string): Promise<void> {
    const call: StubCall = { method: 'PUT_RAW', path, arg: body, extra: contentType };
    await this.dispatch(call);
  }

  private async dispatch(call: StubCall): Promise<unknown> {
    this.calls.push(call);
    // A plain loop, not `.find()`. Some suites in this repo count
    // `Array.prototype.find` calls to prove a tool no longer rescans arrays
    // (tests/tools.hot-loop-maps.test.ts), and they instrument the prototype
    // globally for the duration of the tool call. A `.find()` in the stub's own
    // dispatch would be counted as the tool's and fail those tests for a
    // reason that has nothing to do with the tool.
    let route: RegisteredRoute | undefined;
    for (const candidate of this.routes) {
      if (candidate.method === call.method && candidate.match(call.path)) {
        route = candidate;
        break;
      }
    }
    if (!route) {
      throw new UnexpectedCallError(
        call,
        this.routes.map((r) => `${r.method} ${r.path}`),
      );
    }
    route.hits++;

    const arg = describeArg(call.arg);
    if (route.route.expectParams && arg === null) {
      throw new UnexpectedArgumentError(
        call.method,
        call.path,
        `expected an object carrying ${safeJson(route.route.expectParams)}, got ${safeJson(call.arg)}`,
      );
    }
    if (route.route.expectParams) {
      for (const [key, want] of Object.entries(route.route.expectParams)) {
        const got = arg![key];
        if (safeJson(got) !== safeJson(want)) {
          throw new UnexpectedArgumentError(
            call.method,
            call.path,
            `expected param ${key}=${safeJson(want)}, got ${key}=${safeJson(got)}`,
          );
        }
      }
    }
    if (route.route.rejectParams && arg !== null) {
      for (const key of route.route.rejectParams) {
        if (key in arg) {
          throw new UnexpectedArgumentError(call.method, call.path, `param ${key} must be absent, but was ${safeJson(arg[key])}`);
        }
      }
    }
    if (route.route.times !== undefined) {
      const problem = matchesCount(route.route.times, route.hits);
      if (problem) {
        throw new UnexpectedArgumentError(call.method, call.path, problem);
      }
    }

    return typeof route.route.respond === 'function'
      ? await (route.route.respond as StubResponder)(call)
      : route.route.respond;
  }
}

/**
 * Convenience factory: a stub with a route per entry, plus the call recorder
 * the tests can assert against.
 */
export function makeStubClient(
  routes: Array<[StubMethod, string | RegExp, Route]>,
  opts: { fetchAllCap?: number } = {},
): StubSpotifyClient {
  const stub = new StubSpotifyClient(opts);
  for (const [method, path, route] of routes) stub.route(method, path, route);
  return stub;
}

/**
 * A legacy harness responder: `(path, arg) => value`.
 *
 * `undefined` is read as "this harness did not model that call". That reading
 * is the permissive default the hand-written stubs got wrong, so
 * {@link StubFromResponder} makes it explicit and countable rather than
 * invisible: declined calls are tallied, and in the default `strict` mode the
 * first one throws.
 */
export type LegacyResponder = (path: string, arg?: unknown, method?: string) => unknown;

/** Options for {@link StubFromResponder}. */
export interface ResponderStubOptions {
  fetchAllCap?: number;
  /**
   * `true` (default) — a call the responder declines with `undefined` throws,
   * so a tool reading an endpoint the harness never modelled is a loud failure
   * rather than an empty answer that satisfies an unrelated assertion.
   *
   * `false` — declined calls return `undefined` and are counted. Use this only
   * where the endpoint genuinely 204s or the test is deliberately exercising
   * the "no data" path, and pair it with {@link StubFromResponder.assertNoDeclined}
   * where the test means "nothing was called that we did not model".
   */
  strict?: boolean;
}

/**
 * A `StubSpotifyClient` whose GETs are answered by a legacy `(path, arg)`
 * responder, with the real `getAllPages` inherited.
 *
 * ## Why this exists, and when to stop using it
 *
 * The 19 files that hand-copied the paging loop all had the same shape: a
 * `makeStubClient(responder)` factory over a `(path, arg) => value` function.
 * Rewriting every responder body into explicit routes is the destination, but
 * doing it in one pass buries the actual fix (delete the copy, inherit the
 * real walk) under a few thousand lines of route churn.
 *
 * So this adapter takes the mechanical half now and leaves the strict half as a
 * visible, per-file follow-up:
 *
 * - **Fixed here:** the hand-copied `getAllPages` is gone. Pagination, the cap,
 *   `initialOffset`, the short-page break and the truncation verdict are the
 *   production implementations, so `src/client.ts` regressions reach these
 *   tests with no copy to update. That is acceptance criterion #4.
 * - **Fixed here:** every call is recorded with the argument production sent,
 *   including the `PUT_RAW` Content-Type.
 * - **Still to do per file:** replace the responder body with explicit
 *   `stub.route(...)` entries so an unmodelled path is caught by the route
 *   table rather than by the `undefined` convention.
 *
 * The `undefined` convention is the one place this adapter is deliberately
 * weaker than an explicit route table, and it says so in the error message: a
 * declined call throws by default, and the throw names the call. Use
 * `strict: false` only with a stated reason.
 */
export class StubFromResponder extends StubSpotifyClient {
  /** Read calls the responder declined by returning `undefined`. */
  readonly declined: StubCall[] = [];
  private readonly responder: LegacyResponder;
  private readonly strict: boolean;

  constructor(
    responder: LegacyResponder,
    opts: ResponderStubOptions & {
      /**
       * Per-verb responders for the write methods, mirroring a harness that
       * stubbed `post`/`put`/`delete`/`putRaw` separately from `get`. A verb
       * with no entry here is UNREGISTERED, so calling it throws — a harness
       * that never modelled a write cannot silently accept one.
       *
       * A write responder answering `undefined` is NOT a declined call. A 2xx
       * with no body is a real outcome (204, and `jsonOrNull`'s unreadable-body
       * case), and every hand-written stub returned `undefined` from its write
       * stubs by design. Strictness is applied to READS only, because that is
       * where "answered with a plausible default" hides a regression.
       */
      writes?: Partial<Record<'POST' | 'PUT' | 'DELETE' | 'PUT_RAW', LegacyResponder>>;
    } = {},
  ) {
    super({ fetchAllCap: opts.fetchAllCap });
    this.responder = responder;
    this.strict = opts.strict ?? true;
    this.route('GET', /.*/, {
      respond: (call) => this.answer(call, responder, this.strict),
    });
    for (const [method, fn] of Object.entries(opts.writes ?? {})) {
      this.route(method as StubMethod, /.*/, {
        respond: (call) => this.answer(call, fn, false),
      });
    }
  }

  private answer(call: StubCall, fn: LegacyResponder, strict: boolean): unknown {
    // The method is the THIRD argument because that is where the hand-written
    // clients in the suite already put it. Handlers that branch on the verb
    // (`if (method === 'POST')`) silently took the read branch when the stub
    // did not pass it, which is the same class of lie this helper exists to
    // remove — a responder that looks like it is modelling a write and is not.
    const value = fn(call.path, call.arg, call.method);
    if (value === undefined && strict) {
      this.declined.push(call);
      if (this.strict) {
        throw new UnexpectedCallError(call, ['(the harness responder declined this call)']);
      }
    }
    return value;
  }

  /**
   * Assert no call went unmodelled. The companion to `strict: false` — it turns
   * "the harness returned undefined" into an explicit assertion rather than a
   * silent empty answer.
   */
  assertNoDeclined(): void {
    if (this.declined.length === 0) return;
    const shown = this.declined.map((c) => `${c.method} ${c.path}`).join(', ');
    throw new Error(`StubSpotifyClient: the responder declined ${this.declined.length} call(s): ${shown}`);
  }
}


/**
 * The `GetAllPagesOptions` shape, re-exported so a test that stubs a walk can
 * name the options it forwards without importing from `src/`.
 */
export type { GetAllPagesOptions };

// ---------------------------------------------------------------------------
// The stateful playlist store (#881)
// ---------------------------------------------------------------------------

/** One row of a playlist as the mock holds it. `null` is an unavailable row. */
export type PlaylistRow = string | null;

/** How a seeded playlist answers reads before any write. */
export interface SeededPlaylist {
  /** Row URIs in playlist order; `null` is Spotify's `item: null` row. */
  rows: PlaylistRow[];
  /** Playlist name, echoed by the metadata read. */
  name?: string;
  /** Cover images the `/images` read returns, first one being index 0. */
  images?: SpotifyImage[];
  /**
   * Snapshot ids handed out by each write, in order. The LAST one repeats
   * forever, so a tool that writes more times than seeded still gets a
   * receipt — a test that cares about receipt READABILITY wants
   * `snapshot_id: null` instead, which is a different option
   * (`receiptReadable: false`).
   */
  snapshots?: string[];
  /** `false` makes every write answer with a body carrying no `snapshot_id`. */
  receiptReadable?: boolean;
  /** `public` / `collaborative`, as the metadata read reports them. */
  public?: boolean;
  collaborative?: boolean;
}

/** Per-playlist counters a test asserts against. */
export interface PlaylistWriteLog {
  /** `PUT /playlists/{id}/items` bodies, in order. */
  replaces: Array<{ uris: string[] }>;
  /** `POST /playlists/{id}/items` bodies, in order. */
  appends: Array<{ uris: string[] }>;
  /** `DELETE /playlists/{id}/items` position lists, in the order sent. */
  deletes: number[][];
  /** Every `GET /playlists/{id}/items` page the client served. */
  itemPageReads: number;
}

const TRACK_FROM_URI = /^(?:spotify:track:|spotify:episode:)?([A-Za-z0-9_-]+)$/;

/**
 * A plausible track object for a `spotify:track:<id>` row.
 *
 * `duration_ms` and the artist name VARY with the numeric tail of the id, on
 * purpose. A mock whose every row carried one duration would make
 * `playlist_sort(duration_asc)` a no-op that a broken comparator would pass,
 * and one whose every row shared an artist would do the same for `artist_asc`.
 * The variation is what lets a test tell "sorted by duration" from "sorted by
 * name" — and lets it tell a real sort from a tool that ignored the key.
 */
export function trackRowForUri(uri: string, addedAt = '2026-01-01T00:00:00Z'): PlaylistItemObject {
  const id = TRACK_FROM_URI.exec(uri)?.[1] ?? uri;
  const n = Number(/(\d+)\s*$/.exec(id)?.[1] ?? 0) || 0;
  return {
    added_at: addedAt,
    item: {
      type: 'track',
      id,
      uri,
      name: `Track ${id}`,
      duration_ms: 60_000 + (n % 7) * 30_000,
      artists: [{ id: `artist-${n % 5}`, name: `Artist ${n % 5}` }],
      album: { id: `album-${id}`, name: `Album ${id}` },
    } as unknown as PlaylistItemObject['item'],
  } as PlaylistItemObject;
}

/** `n` distinct `spotify:track:t<n>` URIs, for seeding a fixture of any size. */
export function trackUris(n: number, prefix = 't'): string[] {
  return Array.from({ length: n }, (_, i) => `spotify:track:${prefix}${i}`);
}

/**
 * A {@link StubSpotifyClient} whose playlists are real state: `PUT` replaces,
 * `POST` appends, `DELETE` splices the named positions out, and the item read
 * pages the CURRENT rows with the CURRENT count.
 *
 * ## Why the plain routes were not enough
 *
 * Everything above answers a call with whatever the test decided in advance.
 * That is the right shape for a tool that makes one call, and the wrong shape
 * for the destructive-replace family, whose whole contract is a SEQUENCE:
 * walk the playlist, decide an order, `PUT` the first chunk, `POST` the rest,
 * re-read to verify. A fixed-response stub can assert the first `PUT` and
 * nothing after it, so the questions that actually decide whether the tool is
 * correct — did chunk 2 land, did the clear leave zero rows, does the re-read
 * see the new total — have no observable subject.
 *
 * ## Why this is a mock and not a permissive stub
 *
 * The hazard in a hand-rolled stateful mock is the same one the file header
 * names: it answers a call the test never modelled. Every route here is
 * registered against a playlist that was seeded by name, so a tool that reads
 * an unseeded playlist id, or an endpoint outside the family, still throws
 * {@link UnexpectedCallError} with the registered routes listed. The state is
 * mutable; the ROUTE TABLE is not. That split is the whole point — the mock
 * is allowed to be a fake, it is not allowed to be a shrug.
 *
 * ## The cap is real here, not copied here
 *
 * The item read hands back a genuine {@link SpotifyPaged} whose `total` is the
 * live row count, so the INHERITED `getAllPages` decides for itself whether it
 * hit `fetchAllCap`. A fixture of 600 rows against the default cap of 500
 * therefore truncates the way production truncates, without this file naming
 * 500 anywhere. Change `SPOTIFY_MCP_FETCH_ALL_CAP` and the mock follows,
 * because it never knew the number.
 */
export class StatefulPlaylistClient extends StubSpotifyClient {
  private readonly rows = new Map<string, PlaylistRow[]>();
  private readonly names = new Map<string, string>();
  private readonly covers = new Map<string, SpotifyImage[]>();
  private readonly snapshots = new Map<string, string[]>();
  private readonly receiptReadable = new Map<string, boolean>();
  private readonly visibility = new Map<string, { public?: boolean; collaborative?: boolean }>();
  /** Every mutating call, per playlist, in the order the tool issued it. */
  readonly log = new Map<string, PlaylistWriteLog>();
  /** Ids handed out by `POST /me/playlists`, in creation order. */
  readonly created: Array<{ id: string; name: string; public?: boolean }> = [];
  /** `PUT_RAW` bodies, per playlist path — the cover-art upload. */
  readonly coverUploads = new Map<string, string>();
  private nextCreated = 0;
  /**
   * The snapshot a read reports. A write moves it, so a test that reads the
   * metadata AFTER a write sees a different `snapshot_id` than before — which
   * is what `get_playlist_snapshot` exists to expose.
   */
  private readonly current = new Map<string, string>();

  constructor(opts: { fetchAllCap?: number } = {}) {
    super(opts);
    this.registerPlaylistRoutes();
  }

  /**
   * Add a playlist to the store.
   *
   * Rows are copied, so a test can keep mutating the array it passed in
   * without the store changing underneath it — one accidental alias is enough
   * to make a later assertion pass for the wrong reason.
   */
  seedPlaylist(id: string, seeded: SeededPlaylist): this {
    this.rows.set(id, [...seeded.rows]);
    this.names.set(id, seeded.name ?? `Playlist ${id}`);
    this.covers.set(id, seeded.images ?? []);
    this.receiptReadable.set(id, seeded.receiptReadable ?? true);
    // `snapshots[0]` is the id the playlist was created with; the REST are
    // handed out one per write, in order. The last repeats forever, so a tool
    // that writes more times than seeded still gets a receipt.
    const queue = seeded.snapshots ? [...seeded.snapshots] : [`snapshot-${id}-1`];
    const initial = queue.length > 1 ? queue.shift()! : queue[0]!;
    this.snapshots.set(id, queue);
    if (this.receiptReadable.get(id) === false) this.current.delete(id);
    else this.current.set(id, initial);
    this.visibility.set(id, { public: seeded.public, collaborative: seeded.collaborative });
    this.log.set(id, { replaces: [], appends: [], deletes: [], itemPageReads: 0 });
    return this;
  }

  /** The live rows of a seeded playlist, `null` entries and all. */
  rowsOf(id: string): PlaylistRow[] {
    const rows = this.rows.get(id);
    assertSeeded(id, rows !== undefined, this.rows);
    return [...rows!];
  }

  /** Just the addressable URIs, in order — the shape a replace would carry. */
  urisOf(id: string): string[] {
    return this.rowsOf(id).filter((u): u is string => u !== null);
  }

  /** The write log for a playlist; throws when the id was never seeded. */
  logOf(id: string): PlaylistWriteLog {
    const entry = this.log.get(id);
    assertSeeded(id, entry !== undefined, this.log);
    return entry!;
  }

  /**
   * Every URI the tool ever sent to this playlist's `/items` endpoint, in
   * order, across `PUT` and `POST`. A destructive replace is one `PUT` with
   * the whole ordered list followed by `POST`s for the overflow chunks, so the
   * concatenation is exactly the order the playlist was asked to end up in.
   */
  writtenUris(id: string): string[] {
    const entry = this.logOf(id);
    return [...entry.replaces.flatMap((r) => r.uris), ...entry.appends.flatMap((a) => a.uris)];
  }

  // -------------------------------------------------------------------------

  private nextSnapshot(id: string): string | null {
    if (this.receiptReadable.get(id) === false) return null;
    const list = this.snapshots.get(id) ?? [`snapshot-${id}-1`];
    const value = list.length === 1 ? list[0]! : list.shift() ?? null;
    if (value !== null) this.current.set(id, value);
    return value ?? null;
  }

  private registerPlaylistRoutes(): void {
    // `/playlists/{id}`, `/playlists/{id}/items` and `/playlists/{id}/images`
    // are three routes over ONE playlist, so they must resolve to the same
    // id — a cover read that looked up `A.../images` as its own playlist
    // would be indistinguishable from a tool reading the wrong thing.
    const idOf = (path: string): string =>
      decodeURIComponent(path.replace('/playlists/', '').replace(/\/(?:items|images)$/, ''));

    // `POST /me/playlists` is registered FIRST so it wins the "most recently
    // registered" race against the item/meta routes for the paths it overlaps.
    this.route('POST', '/me/playlists', {
      respond: (call) => {
        const body = (call.arg ?? {}) as { name?: string; public?: boolean };
        const id = `created${this.nextCreated++}`;
        const rows: PlaylistRow[] = [];
        this.seedPlaylist(id, { rows, name: body.name ?? id, public: body.public });
        this.created.push({ id, name: body.name ?? id, public: body.public });
        return { id, name: body.name ?? id, snapshot_id: `snapshot-${id}` };
      },
    });

    // Item read. The `total` is the LIVE count and the page honours the
    // `limit` the walk asked for, so the inherited walk's cap arithmetic is
    // decided by production code reading a real envelope.
    this.route('GET', /^\/playlists\/[^/]+\/items$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const rows = this.rows.get(id);
        assertSeeded(id, rows !== undefined, this.rows);
        this.logOf(id).itemPageReads++;
        const arg = (call.arg ?? {}) as { offset?: string; limit?: string };
        const offset = Number(arg.offset ?? 0) || 0;
        const requested = Number(arg.limit ?? 0);
        const size = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 100) : 50;
        const slice = rows.slice(offset, offset + size);
        const body: SpotifyPaged<PlaylistItemObject> = {
          items: slice.map((uri) => (uri === null ? ({ added_at: '2026-01-01T00:00:00Z', item: null } as PlaylistItemObject) : trackRowForUri(uri))),
          total: rows.length,
          limit: size,
          offset,
          next: offset + size < rows.length ? `offset=${offset + size}` : null,
        };
        return body;
      },
    });

    // Metadata. `items.total` is the current field; `tracks` is the deprecated
    // one, and a tool reading the wrong one is exactly the sort of thing this
    // mock is here to make visible.
    this.route('GET', /^\/playlists\/[^/]+$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const rows = this.rows.get(id);
        assertSeeded(id, rows !== undefined, this.rows);
        const { public: pub, collaborative } = this.visibility.get(id) ?? {};
        return {
          id,
          name: this.names.get(id) ?? `Playlist ${id}`,
          snapshot_id: this.current.get(id) ?? null,
          public: pub,
          collaborative,
          images: this.covers.get(id) ?? [],
          items: { total: rows.length },
        };
      },
    });

    this.route('GET', /^\/playlists\/[^/]+\/images$/, {
      respond: (call) => {
        const id = idOf(call.path);
        assertSeeded(id, this.covers.has(id), this.rows);
        return this.covers.get(id) ?? [];
      },
    });

    // `PUT ... /items` REPLACES — that is the atomic rewrite the whole
    // sort/shuffle/reverse/trim/union/subtract family commits through, and
    // `{ uris: [] }` is the documented clear.
    this.route('PUT', /^\/playlists\/[^/]+\/items$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const rows = this.rows.get(id);
        assertSeeded(id, rows !== undefined, this.rows);
        const uris = readUris(call.arg);
        this.logOf(id).replaces.push({ uris });
        this.rows.set(id, [...uris]);
        return { snapshot_id: this.nextSnapshot(id) };
      },
    });

    // `POST ... /items` APPENDS — the overflow chunks of a >100-URI replace.
    this.route('POST', /^\/playlists\/[^/]+\/items$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const rows = this.rows.get(id);
        assertSeeded(id, rows !== undefined, this.rows);
        const uris = readUris(call.arg);
        this.logOf(id).appends.push({ uris });
        this.rows.set(id, [...rows!, ...uris]);
        return { snapshot_id: this.nextSnapshot(id) };
      },
    });

    // `DELETE ... /items` takes POSITIONS, and positions shift as rows go —
    // so the mock splices exactly as the live playlist would. A stub that
    // ignored the position would make `remove_unavailable_playlist_items`'s
    // highest-first ordering untestable.
    this.route('DELETE', /^\/playlists\/[^/]+\/items$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const rows = this.rows.get(id);
        assertSeeded(id, rows !== undefined, this.rows);
        const positions = readPositions(call.arg);
        this.logOf(id).deletes.push(positions);
        // Highest first within one request, matching Spotify's own semantics
        // for a multi-position delete, so the mock is right even if a tool
        // sends them out of order in a single call.
        const next = [...rows!];
        for (const position of [...positions].sort((a, b) => b - a)) {
          if (position >= 0 && position < next.length) next.splice(position, 1);
        }
        this.rows.set(id, next);
        return { snapshot_id: this.nextSnapshot(id) };
      },
    });

    this.route('PUT', /^\/playlists\/[^/]+\/images$/, { respond: () => undefined });
    this.route('PUT_RAW', /^\/playlists\/[^/]+\/images$/, {
      respond: (call) => {
        this.coverUploads.set(call.path, String(call.arg ?? ''));
        return undefined;
      },
    });
    // Metadata PUT: records the body so a test can assert the exact flags.
    this.route('PUT', /^\/playlists\/[^/]+$/, {
      respond: (call) => {
        const id = idOf(call.path);
        const body = (call.arg ?? {}) as { public?: boolean; collaborative?: boolean; name?: string };
        this.visibility.set(id, { ...this.visibility.get(id), ...body });
        return { id, ...body, snapshot_id: this.nextSnapshot(id) };
      },
    });
  }
}

function readUris(arg: unknown): string[] {
  const body = arg as { uris?: unknown } | null;
  if (body === null || typeof body !== 'object' || !Array.isArray(body.uris)) {
    throw new UnexpectedArgumentError('PUT', '/playlists/<id>/items', `expected a { uris: [...] } body, got ${safeJson(arg)}`);
  }
  return body.uris.map(String);
}

function readPositions(arg: unknown): number[] {
  const body = arg as { tracks?: Array<{ positions?: unknown }> } | null;
  const tracks = body !== null && typeof body === 'object' ? body.tracks : undefined;
  if (!Array.isArray(tracks)) {
    throw new UnexpectedArgumentError('DELETE', '/playlists/<id>/items', `expected a { tracks: [{ positions: [...] }] } body, got ${safeJson(arg)}`);
  }
  return tracks.flatMap((t) => (Array.isArray(t?.positions) ? t.positions.map(Number) : []));
}

/**
 * An unseeded id must fail loudly. A mock that invented an empty playlist for
 * it would make "the tool read the wrong playlist" look like "the tool found
 * an empty playlist" — the permissive-default bug this file exists to
 * prevent, in a new outfit.
 */
function assertSeeded(id: string, present: boolean, known: Map<string, unknown>): void {
  if (present) return;
  throw new Error(
    `StatefulPlaylistClient: playlist "${id}" was never seeded. ` +
      `Seeded playlists: ${known.size > 0 ? [...known.keys()].join(', ') : '(none)'}. ` +
      `A mock that answered for an unseeded playlist would make "the tool read the wrong id" ` +
      `look like "the tool found an empty playlist".`,
  );
}
