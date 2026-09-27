/**
 * Resource subscriptions (#597): `resources/subscribe`, and the
 * `notifications/resources/updated` it promises.
 *
 * ## What "changed" means here, and why it is not the same as "I looked again"
 *
 * The Spotify Web API has no change feed, no webhook and no delta cursor for
 * any endpoint this server reads. A server can therefore only learn that
 * something changed by reading it again and comparing. That is the whole
 * mechanism, and the danger is that the comparison is quietly dropped and the
 * poll is presented as a change instead — which is the "a value that could
 * not be read coerced into a plausible answer" shape this repository has
 * shipped twice (#803, #830).
 *
 * So a subscription here is a **vector**, not a heartbeat:
 *
 *  - Each watchable resource declares a {@link WatchableResource.vector}: a
 *    projection of its JSON body down to the fields that *are* the change
 *    event. The vector is compared to the last one **successfully observed**.
 *  - A poll whose read **failed** is not a change and is not a no-op: it leaves
 *    the baseline alone, backs the interval off, and records the failure. The
 *    next successful read is compared against the last good vector, so a
 *    change during a failing stretch is still reported and reported once.
 *  - A poll that reads successfully and produces the **same** vector sends
 *    **nothing**. The distinction is structural — a change is the *presence* of
 *    a `notifications/resources/updated`, and "I looked again and it had not" is
 *    its absence. There is no field to misread, because there is no field.
 *
 * ## Why the vectors are not "hash the body"
 *
 * Several of these bodies carry a continuously-advancing field. Hashing the
 * body would make every one of them change on every poll:
 *
 *  - `spotify://player/state` carries `progress_ms`, which moves every read.
 *  - `spotify://me/rate-limit` renders `cooldownRemainingMs` and a request
 *    counter, both functions of the clock and of this server's own traffic.
 *
 * A timer that fires a notification is precisely what this module must not
 * ship, so each vector is hand-declared and its **exclusions** are declared
 * beside it in {@link WatchableResource.vectorDoc}. A host that wants the
 * playback position or the live request count re-reads the resource, which is
 * a live read either way.
 *
 * ## Why the watchable set is a fixed list of bare URIs
 *
 * Three reasons, and the first is the one that matters:
 *
 *  1. **A resource the server will never watch must not be subscribable.** A
 *     subscription that is accepted and can never fire is a promise the server
 *     cannot keep, so `subscribe` refuses anything outside this list and says
 *     what the list is.
 *  2. **The watched resources must be read live, not from the TTL cache.**
 *     Every endpoint behind a watchable URI is under `/me/player*` (which
 *     {@link shouldBypassCache} exempts) or reads no API at all. A resource
 *     served from the ~5 min payload cache cannot be watched honestly: the poll
 *     would re-read the same cached body, see no change, and report nothing for
 *     as long as the cache entry lived. `tests/resource-subscriptions.test.ts`
 *     drives the real client and asserts the poll actually re-fetches.
 *  3. **Template URIs are excluded deliberately.** `spotify://playlist/{id}`
 *     and its siblings are readable at any id; watching one means an
 *     unauthenticated-by-scope read loop the operator never asked for, billed
 *     per poll. The bare URI of a watchable resource is the unit of
 *     subscription, and `?format=json` is a *read* spelling rather than a
 *     second watchable identity.
 *
 * ## The notification payload
 *
 * Exactly `{"uri": …}` — the MCP `notifications/resources/updated` shape, and
 * nothing else. The issue asked for "the uri and the vector, no nested prose",
 * and the vector is deliberately NOT put on the wire: `ResourceUpdatedNotification`
 * is a spec-defined `{uri}` and a client validating against
 * `ResourceUpdatedNotificationSchema` strips anything else, so a vector there
 * would be a field most hosts never see. The vector is change-detection
 * bookkeeping, not a contract, and what tells a host "this changed" is that a
 * notification arrived at all.
 *
 * ## Lifecycle
 *
 * One {@link SubscriptionManager} per `McpServer`. Over stdio that is the
 * process; over the opt-in HTTP transport (#599) it is one per session, which
 * is what scopes a notification to the client that asked for it. Every
 * subscription owns exactly one `setTimeout` chain — not an interval, so a read
 * slower than the poll interval cannot overlap itself — and every chain is
 * cleared by `resources/unsubscribe`, by `stopAll()`, and by the transport
 * closing. {@link SubscriptionManager.liveTimers} is the instrument that makes
 * a leak assertable rather than a code-reading exercise.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { asRecord, readNumber, readString } from '../shaping.js';
import { SUBSCRIPTION_POLL_RANGE, subscriptionPollEnv, subscriptionsEnabled } from '../config.js';

/** `ResourceContents`, aliased to the SDK type exactly as `resources/index.ts` does. */
type ResourceContents = ReadResourceResult;

/** How a watchable resource's body is read. Same signature the registrar takes. */
export type ResourceRenderer = (url: URL) => Promise<ResourceContents>;

/**
 * The renderers the read surface registered, keyed by bare URI.
 *
 * The subscription poll reads through **these** renderers rather than through
 * a second copy of each read. A copy is how a resource and its watcher end up
 * disagreeing about what the resource contains, and the disagreement is
 * invisible until a change is reported that a `resources/read` would not have
 * found.
 */
export interface ResourceReadRegistry {
  register(uri: string, render: ResourceRenderer): void;
  renderFor(uri: string): ResourceRenderer | undefined;
}

export function createResourceReadRegistry(): ResourceReadRegistry {
  const renderers = new Map<string, ResourceRenderer>();
  return {
    register(uri, render) {
      renderers.set(uri, render);
    },
    renderFor(uri) {
      return renderers.get(uri);
    },
  };
}

/** A resource whose change is observable, and how to observe it. */
export interface WatchableResource {
  /** The exact bare URI. Nothing else subscribes. */
  readonly uri: string;
  /** Appended to the resource's registered description, so `resources/list` advertises it. */
  readonly note: string;
  /** The full statement of what the vector covers, for docs. */
  readonly vectorDoc: string;
  /**
   * Project a parsed JSON body to a comparable string. Throwing means "this
   * body is not a reading" — the poll records a failed read rather than
   * inventing a vector for a payload it did not understand.
   */
  readonly vector: (payload: unknown) => string;
}

/**
 * A payload that is not the JSON object the vector expects. Refusing is the
 * point: the alternative is projecting `undefined` fields to placeholder
 * strings, which produces a *stable* vector for a body that was never read —
 * a subscription that then reports "no change" forever.
 */
function requireRecord(payload: unknown, uri: string): Record<string, unknown> {
  const record = asRecord(payload);
  if (!record) {
    throw new Error(`${uri} returned a body that is not a JSON object; the poll could not determine whether it changed`);
  }
  return record;
}

/** `null` for a field that is legitimately absent, never `undefined`-as-a-value. */
function field(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'unrepresentable';
}

const NO_SESSION = 'no-session';

const PLAYER_STATE: WatchableResource = {
  uri: 'spotify://player/state',
  vectorDoc:
    'the current item URI, `is_playing`, `shuffle_state`, `repeat_state` and the active device id, plus a distinct '
    + 'vector for "the endpoint returned no playback state at all". `progress_ms` and `timestamp` are excluded: they '
    + 'advance on every read, and a position that moved is not a change event — a host wanting the position re-reads '
    + 'the resource, which is a live read.',
  note:
    'Subscribable: a notifications/resources/updated fires only when the current item, play/pause, shuffle, repeat '
    + 'or active device changes. A re-check that finds no change sends nothing, and a failed read sends nothing either.',
  vector: (payload) => {
    // `/me/player` answers 204 with no body when there is no active session,
    // which the client surfaces as `null`. That is a real state, not a failed
    // read, so it gets its own vector rather than being read as a missing field.
    if (payload === null) return NO_SESSION;
    const rec = requireRecord(payload, PLAYER_STATE.uri);
    const item = asRecord(rec.item);
    return [
      item ? field(readString(rec, 'item.uri')) : 'no-item',
      field(rec.is_playing),
      field(rec.shuffle_state),
      field(rec.repeat_state),
      readString(rec, 'device.id') ?? 'no-device',
    ].join('|');
  },
};

const PLAYER_QUEUE: WatchableResource = {
  uri: 'spotify://player/queue',
  vectorDoc:
    'the URI of every queued item in order, plus the URI of the item currently playing, plus a distinct vector for '
    + '"the endpoint returned no queue at all". Order is part of the vector: a reordered queue is a change, and '
    + 'nothing else in this body is.',
  note:
    'Subscribable: a notifications/resources/updated fires only when the currently-playing item or the ordered queue '
    + 'changes. A re-check that finds no change sends nothing, and a failed read sends nothing either.',
  vector: (payload) => {
    if (payload === null) return NO_SESSION;
    const rec = requireRecord(payload, PLAYER_QUEUE.uri);
    const queued = Array.isArray(rec.queue) ? rec.queue : null;
    if (!queued) {
      throw new Error(`${PLAYER_QUEUE.uri} returned no queue array; the poll could not determine whether it changed`);
    }
    const playing = asRecord(rec.currently_playing);
    return [
      playing ? field(readString(rec, 'currently_playing.uri')) : 'no-item',
      ...queued.map((row) => field(readString(row, 'uri'))),
    ].join('|');
  },
};

const RECENTLY_PLAYED: WatchableResource = {
  uri: 'spotify://me/recently-played',
  vectorDoc:
    'the `played_at` and track URI of every row on the page, in order. The default read is the first 20 rows, so a new '
    + 'play shifts the whole vector — which is the change. Nothing about the row order is time-of-day dependent, and no '
    + 'cursor is compared: a cursor that moved without the rows moving is not something this host can act on.',
  note:
    'Subscribable: a notifications/resources/updated fires when the recently-played page changes — a new play, a new '
    + 'window. A re-check that finds no change sends nothing, and a failed read sends nothing either.',
  vector: (payload) => {
    const rec = requireRecord(payload, RECENTLY_PLAYED.uri);
    const items = Array.isArray(rec.items) ? rec.items : null;
    if (!items) {
      throw new Error(`${RECENTLY_PLAYED.uri} returned no items array; the poll could not determine whether it changed`);
    }
    return items
      .map((row) => {
        const entry = asRecord(row);
        if (!entry) throw new Error(`${RECENTLY_PLAYED.uri} returned a non-object row; the vector cannot be built`);
        return `${field(readString(entry, 'played_at'))}@${field(readString(entry, 'track.uri'))}`;
      })
      .join('|');
  },
};

const RATE_LIMIT: WatchableResource = {
  uri: 'spotify://me/rate-limit',
  vectorDoc:
    'the timestamp and Retry-After of the LAST throttle event, and nothing else. The request counters and the cooldown '
    + 'countdown this resource also renders are excluded on purpose: they advance with this server\'s own traffic and '
    + 'with the clock, so a vector that included them would fire on every poll — a timer wearing a change notification\'s '
    + 'name, which is the exact defect this module exists to avoid. A host wanting a live counter re-reads the resource.',
  note:
    'Subscribable: a notifications/resources/updated fires only on a NEW throttle event. The request counters and the '
    + 'cooldown countdown advance continuously and are not change events — re-read the resource for those.',
  vector: (payload) => {
    const rec = requireRecord(payload, RATE_LIMIT.uri);
    return [field(readNumber(rec, 'lastThrottleAt') ?? null), field(rec.retryAfterSec ?? null)].join('|');
  },
};

/**
 * Every resource this server will watch, in the order a host reads the list.
 *
 * This is the whole advertised set. It is a `readonly` array of named
 * constants rather than a derived list so that "which resources are watchable"
 * is one literal to read, one to extend, and one to print in an error message —
 * and so that adding a resource here without a `vector` is a type error rather
 * than a subscription that compares nothing.
 */
export const WATCHABLE_RESOURCES: readonly WatchableResource[] = [
  PLAYER_STATE,
  PLAYER_QUEUE,
  RECENTLY_PLAYED,
  RATE_LIMIT,
];

const BY_URI = new Map(WATCHABLE_RESOURCES.map((w) => [w.uri, w]));

export function watchableFor(uri: string): WatchableResource | undefined {
  return BY_URI.get(uri);
}

/** What `resources/subscribe` says when it refuses a URI. Never names a resource that does not exist. */
export function watchableList(): string {
  return WATCHABLE_RESOURCES.map((w) => w.uri).join(', ');
}

/**
 * Parse the JSON body a watchable read produced.
 *
 * A body that is absent or is not JSON is a **failed read**, not an empty
 * reading: `JSON.parse` is allowed to throw, and the caller records the failure
 * and leaves the baseline alone. Returning `null` here for a parse failure
 * would be the bug this module is written against — `null` means "no playback
 * state" to these vectors, so a parse failure that became `null` would report
 * a session that had ended.
 */
function readJsonBody(contents: ResourceContents, uri: string): unknown {
  const first = contents.contents?.[0];
  // A `blob` content entry is not a reading: there is no text to compare, and
  // treating its presence as a change would be reporting on bytes nobody read.
  const body = first && 'text' in first ? first.text : undefined;
  if (typeof body !== 'string') {
    throw new Error(`${uri} returned no readable body; the poll could not determine whether it changed`);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new Error(`${uri} returned a body that is not JSON; the poll could not determine whether it changed`);
  }
}

/**
 * One live subscription. Its baseline is `null` until a first read succeeds.
 *
 * Liveness is **object identity**, not a counter: `unsubscribe` deletes the map
 * entry and `subscribe` builds a fresh one, so a read still in flight from a
 * cancelled subscription can never be mistaken for the read belonging to the
 * subscription that replaced it. A generation counter would be a second
 * mechanism for the same fact, and a second mechanism is a second thing to get
 * wrong.
 */
interface Subscription {
  readonly uri: string;
  /** The last vector that was SUCCESSFULLY read, or `null` before the first. */
  vector: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One row of {@link SubscriptionManager.snapshot}, for tests and the doctor. */
export interface SubscriptionState {
  readonly uri: string;
  /** `null` until the first successful read — the window in which nothing is yet being compared. */
  readonly vector: string | null;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  readonly unreadable: boolean;
}

export interface SubscriptionManager {
  readonly enabled: boolean;
  /** Subscriptions currently held, whether or not they have ever read successfully. */
  activeCount(): number;
  /**
   * Timers currently armed. The leak instrument: a subscription removed from
   * the map with its timer still armed shows up here as a non-zero count, and
   * as reads that keep happening after an unsubscribe.
   */
  liveTimers(): number;
  snapshot(): SubscriptionState[];
  subscribe(uri: string): void;
  unsubscribe(uri: string): void;
  stopAll(): void;
}

/** Consecutive-failure backoff ceiling, as a multiple of the poll interval. */
const BACKOFF_CAP = 16;

export interface SubscriptionManagerOptions {
  /** Passed through from config; `false` means the capability is not advertised at all. */
  enabled: boolean;
  /** Poll interval in ms. Tests pass a small one; production passes the resolved config value. */
  pollMs: number;
  reads: ResourceReadRegistry;
  /** Send the notification. Injectable so the manager can be driven without a transport. */
  send: (uri: string) => Promise<void>;
  /** Discloses a read that started failing, and its recovery. Defaults to stderr. */
  onUnreadableChange?: (line: string) => void;
}

export function createSubscriptionManager(options: SubscriptionManagerOptions): SubscriptionManager {
  const { enabled, pollMs, reads, send } = options;
  const report = options.onUnreadableChange ?? ((line: string) => console.error(line));
  const subscriptions = new Map<string, Subscription>();
  let liveTimers = 0;

  const arm = (entry: Subscription, delayMs: number): void => {
    const timer = setTimeout(() => {
      liveTimers -= 1;
      entry.timer = null;
      void poll(entry);
    }, delayMs);
    // `unref` is deliberately NOT called. A subscription poll is real work the
    // operator asked for, and the process should outlive it only as long as
    // the transport is up; `stopAll` is what ends it. A leaked timer that
    // cannot keep the process alive is also a leaked timer that a short test
    // run never notices, which is the class of defect this repo keeps paying
    // for.
    entry.timer = timer;
    liveTimers += 1;
  };

  /**
   * One poll cycle. Three terminal states, and only one of them notifies:
   *
   *  - **changed** — read OK, vector differs from the last good one: update the
   *    baseline and send `notifications/resources/updated`.
   *  - **unchanged** — read OK, vector identical: send nothing.
   *  - **unreadable** — the read threw, or the body was not a reading: send
   *    nothing, keep the baseline, back off, and record the reason.
   */
  const poll = async (entry: Subscription): Promise<void> => {
    // A read that was in flight when the host unsubscribed finishes into
    // nothing: it neither notifies nor re-arms. Checking here, before the read
    // starts, is what makes the unsubscribe prompt rather than racing one read.
    if (!isLive(entry)) return;
    let vector: string;
    try {
      const watchable = watchableFor(entry.uri);
      if (!watchable) throw new Error(`${entry.uri} is no longer watchable`);
      const render = reads.renderFor(entry.uri);
      if (!render) throw new Error(`${entry.uri} has no registered reader; the poll cannot read it`);
      // Read through the SAME renderer `resources/read` uses, in its
      // `?format=json` spelling, so the body compared here is the body a host
      // would get. The raw renderer is used deliberately: the graceful-403
      // mapping turns an unreadable resource into a well-formed prose body,
      // and a degraded body must read as a failed read, not as a change.
      const contents = await render(new URL(`${entry.uri}?format=json`));
      vector = watchable.vector(readJsonBody(contents, entry.uri));
    } catch (error) {
      if (!isLive(entry)) return;
      entry.consecutiveFailures += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      if (entry.consecutiveFailures === 1) {
        report(
          `[spotify-mcp] ${entry.uri} subscription could not be read (${entry.lastError}); `
            + 'no change notification will be sent for it until a read succeeds, and the baseline is unchanged',
        );
      }
      // Back off so an unreadable resource — a 403 with no Premium, say — does
      // not turn into a request loop, while still self-healing if the cause
      // clears. The cap is a multiple of the interval, not a new constant.
      const delay = pollMs * Math.min(BACKOFF_CAP, 2 ** (entry.consecutiveFailures - 1));
      arm(entry, delay);
      return;
    }
    if (!isLive(entry)) return;
    const changed = entry.vector !== null && entry.vector !== vector;
    const recovered = entry.consecutiveFailures > 0;
    entry.vector = vector;
    entry.consecutiveFailures = 0;
    entry.lastError = null;
    if (recovered) {
      report(`[spotify-mcp] ${entry.uri} subscription reads again; change detection resumed`);
    }
    if (changed) {
      // Send BEFORE re-arming so a throwing transport cannot stop the poll.
      try {
        await send(entry.uri);
      } catch {
        // A failed send is not a reason to re-arm twice; the baseline is
        // already updated, so the next differing vector still notifies.
      }
    }
    if (!isLive(entry)) return;
    arm(entry, pollMs);
  };

  /** The entry is still the one the map holds — no unsubscribe raced the read. */
  const isLive = (entry: Subscription): boolean => subscriptions.get(entry.uri) === entry;

  const requireWatchable = (uri: string): WatchableResource => {
    const watchable = watchableFor(uri);
    if (watchable) return watchable;
    throw new McpError(
      ErrorCode.InvalidParams,
      `${uri} is not a subscribable resource. This server watches a fixed set of bare URIs: ${watchableList()}. `
        + 'A resource can be readable without being watchable — a watched resource is re-read on an interval, and a '
        + 'resource the server will not re-read cannot honestly be promised a change notification.',
    );
  };

  return {
    enabled,
    activeCount: () => subscriptions.size,
    liveTimers: () => liveTimers,
    snapshot: () =>
      [...subscriptions.values()].map((entry) => ({
        uri: entry.uri,
        vector: entry.vector,
        consecutiveFailures: entry.consecutiveFailures,
        lastError: entry.lastError,
        unreadable: entry.consecutiveFailures > 0,
      })),
    subscribe(uri) {
      requireWatchable(uri);
      const existing = subscriptions.get(uri);
      if (existing) return;
      const entry: Subscription = {
        uri,
        vector: null,
        consecutiveFailures: 0,
        lastError: null,
        timer: null,
      };
      subscriptions.set(uri, entry);
      // The first arm is at the full interval, not immediately. A poll taken
      // the instant the host subscribes would establish the baseline from the
      // state at subscribe time, so a change that happened between the host's
      // last `resources/read` and its `resources/subscribe` would never be
      // reported. The window is real and is stated in SPEC.md rather than
      // papered over: a host that must not miss it re-reads after subscribing.
      arm(entry, pollMs);
    },
    unsubscribe(uri) {
      const entry = subscriptions.get(uri);
      if (!entry) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `${uri} is not currently subscribed; there is no subscription to cancel`,
        );
      }
      // Deleting the map entry is what makes an in-flight read stale: `isLive`
      // compares by object identity, so the read that is still running belongs
      // to an entry nothing can reach any more.
      subscriptions.delete(uri);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
        liveTimers -= 1;
      }
    },
    stopAll() {
      for (const entry of [...subscriptions.values()]) {
        if (entry.timer !== null) {
          clearTimeout(entry.timer);
          entry.timer = null;
          liveTimers -= 1;
        }
      }
      subscriptions.clear();
    },
  };
}

/**
 * Install the two request handlers and the close hook against an existing
 * manager.
 *
 * Split out of {@link installResourceSubscriptions} so a test can drive the
 * real protocol — real `resources/subscribe` over a real transport — against a
 * manager built at a poll interval a test can wait for. The production
 * interval has a floor of one second precisely because it is a quota knob, and
 * a test that needed a faster one would otherwise have to weaken that floor.
 */
export function installSubscriptionHandlers(server: McpServer, manager: SubscriptionManager): void {
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    if (!manager.enabled) {
      // Not advertised, so a conforming host should never send this. A host
      // that does gets the protocol's own answer for a method this server does
      // not implement, plus the one thing that would make it implementable.
      throw new McpError(
        ErrorCode.MethodNotFound,
        'This server does not implement resources/subscribe. Set SPOTIFY_MCP_SUBSCRIPTIONS=1 to advertise it and watch: '
          + `${watchableList()}.`,
      );
    }
    manager.subscribe(request.params.uri);
    return {};
  });

  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    manager.unsubscribe(request.params.uri);
    return {};
  });

  // The transport closing is the other end of the session. A host that
  // disconnects without unsubscribing must not leave a poll running, and over
  // the HTTP transport (#599) there is no other moment at which that is
  // observable. The previous handler is chained, not replaced: `onclose` is a
  // public field another module may already have claimed.
  const inner = server.server.onclose;
  server.server.onclose = () => {
    manager.stopAll();
    inner?.();
  };
}

/**
 * Advertise `resources.subscribe` and install the subscription surface.
 *
 * Returns the manager whether or not subscriptions are enabled: when they are
 * off, the manager is inert (`enabled: false`, and the handler refuses) so a
 * caller holding it cannot accidentally have got a live one.
 *
 * The capability is registered through `registerCapabilities`, which MERGES
 * with what the SDK registered when the first resource was registered, so the
 * `listChanged: true` the SDK owns survives. Registering it is only possible
 * before a transport is connected, which is why this runs inside
 * `buildMcpServer` and not on first subscription.
 */
export function installResourceSubscriptions(server: McpServer, reads: ResourceReadRegistry): SubscriptionManager {
  const enabled = subscriptionsEnabled();
  const pollMs = subscriptionPollEnv();
  const manager = createSubscriptionManager({
    enabled,
    pollMs,
    reads,
    send: (uri) => server.server.sendResourceUpdated({ uri }),
  });

  installSubscriptionHandlers(server, manager);

  if (enabled) {
    server.server.registerCapabilities({ resources: { subscribe: true } });
    console.error(
      `[spotify-mcp] SPOTIFY_MCP_SUBSCRIPTIONS is set — resources.subscribe is advertised; `
        + `${WATCHABLE_RESOURCES.length} resources are watchable (${watchableList()}), re-read every ${pollMs}ms `
        + `(SPOTIFY_MCP_SUBSCRIPTION_POLL_MS, ${SUBSCRIPTION_POLL_RANGE.minMs}-${SUBSCRIPTION_POLL_RANGE.maxMs}ms, `
        + `default ${SUBSCRIPTION_POLL_RANGE.defaultMs}ms)`,
    );
  }

  return manager;
}
