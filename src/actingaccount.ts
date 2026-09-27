/**
 * The acting-account echo (#602).
 *
 * The issue's Impact section names the failure this exists for: "agents that
 * mutate state therefore cannot state whose library they touched… a
 * wrong-account write is indistinguishable from a correct one in the audit
 * trail." Adding `account_id` to results is what makes them distinguishable,
 * and it has to be added in ONE place — a field on 587 call sites is 587
 * chances to forget, and the ones you forget are exactly the writes.
 *
 * ## Why a boundary and not a helper
 *
 * A boundary wraps `server.tool`/`registerTool` once and touches every
 * registered tool, including tools added later by a module nobody re-reads.
 * The two existing boundaries already do this for truncation (#53) and
 * progress (#65), and they install in a deliberate order: progress must wrap
 * first so the truncation wrapper's `runInToolContext` is the inner one and the
 * actor it records is the real tool. This boundary installs LAST, so it is the
 * OUTERMOST wrapper and sees the finished, shaped result. Adding the field
 * after shaping rather than before means the two concerns cannot interfere:
 * shaping measures and rewrites the payload it was given, and does not have to
 * know that three scalar fields arrived from somewhere else.
 *
 * ## What is NOT added, and why that matters
 *
 * When the identity cannot be read, nothing is added. Not `null`, not a
 * placeholder, not the profile name. A field that is present and empty reads
 * as a fact — "this account has no id" — when what is true is "we could not
 * find out", and §6's rule is that a value which could not be read is reported
 * as unreadable, never coerced into a plausible one. An absent key is the
 * honest signal, and {@link resolveActingAccount} is what a caller uses when it
 * needs to tell the two apart.
 *
 * The negative is cached per token file for the same reason it is per token
 * file rather than global: a switch re-points `client.tokenFile`, so the cache
 * entry that described the previous account is simply not the one looked up
 * next. The cache cannot outlive the account it describes, and no code has to
 * remember to clear it.
 */
import type { SpotifyClient } from './client.js';
import { currentActingIdentity, rememberActingIdentity, tokenFileIsUsable } from './accounts.js';
import type { UserProfile } from './types/spotify.js';

/** The two fields the echo adds to `structuredContent`. */
export interface ActingAccountEcho {
  account_id: string;
  display_name: string | null;
}

/**
 * Token files whose identity could not be read, so a server with no credentials
 * does not retry a doomed read on every single tool call. Keyed by token file,
 * which is what makes a switch re-probe: the new account is a different key and
 * has no entry here.
 */
const unreadable = new Set<string>();

/** Drop the negative cache. For tests; production has no reason to call it. */
export function resetActingAccountProbe(): void {
  unreadable.clear();
}

/**
 * The account this session is acting as, or undefined when it cannot be known.
 *
 * Cached per token file and resolved at most once per account per session: the
 * answer needs a live `GET /me`, and one request on the first call of a session
 * is a fair price for a field that is then on every result. Re-reading it per
 * call would be a request per call, and the identity it returns does not change
 * while the token file does not.
 *
 * `tokenFileIsUsable` runs FIRST, before any request. Without it a server
 * started with no credentials — a `tools/list` probe, a CI harness, a
 * `spotify_doctor` run on a fresh machine — would attempt an authenticated
 * request on every tool call, and the failure of that request is a network
 * round trip that buys nothing.
 */
export async function resolveActingAccount(
  client: SpotifyClient,
): Promise<ActingAccountEcho | undefined> {
  const tokenFile = client.tokenFile;
  const cached = currentActingIdentity(tokenFile);
  if (cached) return { account_id: cached.accountId, display_name: cached.displayName };
  if (unreadable.has(tokenFile)) return undefined;
  if (!tokenFileIsUsable(tokenFile)) {
    unreadable.add(tokenFile);
    return undefined;
  }
  let me: UserProfile | null;
  try {
    me = await client.get<UserProfile>('/me');
  } catch {
    // A 401 here means the token is present but not usable; a network failure
    // means Spotify could not be reached. Neither is a reason to fabricate an
    // identity, and neither is worth retrying on the next call.
    unreadable.add(tokenFile);
    return undefined;
  }
  // `/me` answered without a usable key. Registering under the user `id` is the
  // right answer for a REGISTRY entry, which needs a stable key to be
  // addressable at all; it is the wrong answer for a field whose job is to say
  // which account a result belongs to, where a near-miss reads as a match.
  const accountId = me?.account_id;
  if (!accountId) {
    unreadable.add(tokenFile);
    return undefined;
  }
  rememberActingIdentity(tokenFile, { accountId, displayName: me?.display_name ?? null });
  return { account_id: accountId, display_name: me?.display_name ?? null };
}

/**
 * Tools whose results must not receive the echo.
 *
 * `list_accounts` reports the acting account as its SUBJECT, and stamping the
 * same two fields onto the envelope around that is redundant at best. It is not
 * a recursion guard — the echo is resolved with `client.get`, which is not a
 * tool call and so cannot re-enter this boundary.
 */
const ECHO_EXEMPT: ReadonlySet<string> = new Set(['list_accounts']);

/**
 * Wrap every registered tool's callback so its result carries the acting
 * account. Installed AFTER the other two boundaries, and therefore outermost.
 *
 * Results are returned BY IDENTITY when there is nothing to add, so the common
 * unauthenticated path costs one memoized lookup and allocates nothing. That
 * identity return is the same discipline the truncation boundary keeps, and it
 * is load-bearing for more than tidiness: a host that compares a result object
 * by reference gets a stable answer when nothing changed.
 */
export function installActingAccountBoundary(
  server: object,
  resolve: (client: SpotifyClient) => Promise<ActingAccountEcho | undefined>,
  client: SpotifyClient,
): void {
  const api = server as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const originalTool = api.tool.bind(server);
  const originalRegisterTool = api.registerTool.bind(server);

  const remember = (name: string, args: unknown[], callbackIndex: number): void => {
    if (typeof args[callbackIndex] !== 'function') return;
    const callback = args[callbackIndex] as (...callArgs: unknown[]) => unknown;
    args[callbackIndex] = async (...callArgs: unknown[]) => {
      const result = await callback(...callArgs);
      return stamp(name, result, await resolve(client));
    };
  };

  api.tool = (...args: unknown[]) => {
    // The callback is the LAST argument of `tool`, not a fixed index: the SDK
    // accepts `tool(name, description, schema, cb)` with or without the
    // description, and a hard-coded 2 wraps the inputSchema instead of the
    // handler — which reads as a boundary that installed and did nothing.
    remember(String(args[0]), args, args.length - 1);
    return originalTool(...args);
  };
  api.registerTool = (...args: unknown[]) => {
    // `registerTool(name, config, cb)` — the callback IS index 2.
    remember(String(args[0]), args, 2);
    return originalRegisterTool(...args);
  };
}

/** Add the echo to one result, or return it unchanged. */
function stamp(name: string, result: unknown, echo: ActingAccountEcho | undefined): unknown {
  if (!echo || ECHO_EXEMPT.has(name)) return result;
  if (result == null || typeof result !== 'object') return result;
  const record = result as {
    structuredContent?: unknown;
    content?: unknown;
    [key: string]: unknown;
  };
  // A tool that returned no structured payload gets none here either. There is
  // no envelope to attach to, and inventing a `{ account_id }` object beside
  // a result that never claimed to be machine-readable would change the
  // contract of tools that deliberately return prose only.
  if (record.structuredContent == null || typeof record.structuredContent !== 'object') return result;
  if (Array.isArray(record.structuredContent)) return result;
  return {
    ...record,
    structuredContent: { ...(record.structuredContent as object), ...echo },
  };
}
