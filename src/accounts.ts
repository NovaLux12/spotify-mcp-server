/**
 * The account registry (#602): which local accounts exist, and which one this
 * session is acting as.
 *
 * ## What this adds, and what already existed
 *
 * Multi-account support was already half here before this module. `getTokenFile`
 * in `src/auth.ts` resolves ONE token file per process from
 * `SPOTIFY_MCP_TOKEN_FILE` / `--profile` / `SPOTIFY_MCP_PROFILE` (#609, #617),
 * and every per-account store — the persisted read cache (#893/#1249), the
 * doctor, the refresh guard — is derived from that one resolution rather than
 * re-deriving a profile of its own. What did not exist was any way to NAME an
 * account, to enumerate the ones on the box, or to change which one a live
 * session acts as.
 *
 * So this module does not re-implement token resolution. It resolves a
 * *profile name* to a token file through {@link getTokenFile}, the same
 * resolver everything else already uses. The account a session is ACTING as is
 * not tracked here at all: `SpotifyClient.tokenFile` is already that, and a
 * second copy of it in a module-level variable is a second thing to forget to
 * update — the exact shape of bug the header above is about. One resolver, one
 * holder.
 *
 * ## Why the registry is a FILE and not a `/me` sweep
 *
 * An account's identity (`account_id`, the pseudoanonymous immutable id
 * Spotify added to `PrivateUserObject`) is only knowable by making a live
 * authenticated request with that account's token. Enumerating accounts by
 * calling `/me` per candidate token file would mean N live requests every time
 * anyone asked "which accounts do I have", and a wrong or revoked token in the
 * set would make the whole listing fail rather than report the accounts that
 * do work. The registry is instead a local index — the account, its label, and
 * the token file it authenticates with — populated by `switch_account`, the
 * only thing in this tree that writes it. `spotify-mcp auth --profile <name>`
 * creates a token file but never registers the account, so a profile is not in
 * the registry until something switches to it (#1465).
 *
 * ## The isolation property, stated as the rule this file enforces
 *
 * **A registry entry never carries token material.** An entry is an identity
 * (`account_id`), a human label, a profile name, and the PATH of the token
 * file. The path is not a secret — the doctor already prints it, and the
 * operator named it on the command line — but the bytes behind it are, so no
 * `access_token` / `refresh_token` value is ever read into a registry entry,
 * persisted by this module, or returned by a tool that reads it. `list_accounts`
 * projects entries through {@link AccountSummary}, a type that structurally
 * cannot hold a token, so the guarantee does not depend on remembering to
 * redact at each call site.
 *
 * The other half of the isolation property is at READ time rather than write
 * time, and it lives in `src/client.ts`: the in-memory read cache is keyed by
 * request, not by account, so a switched session must not serve the previous
 * account's cached reads. `switchAccount` clears it for exactly that reason.
 */
import { chmod, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getTokenFile, isTokenData } from './auth.js';
import { ownStoreRoots, readLocalFileSync } from './paths.js';
import type { TokenData } from './types/spotify.js';
import { storePath } from './config.js';

/**
 * Where the registry lives: beside the token files it points at, so a
 * relocated home (`SPOTIFY_MCP_DATA_DIR`, or `HOME` itself under the hermetic
 * test helper) relocates the whole account story at once.
 *
 * NEW ENV VAR SPOTIFY_MCP_ACCOUNTS_FILE — absolute path of the registry.
 * Overrides the location; nothing else about the format changes.
 */
export function accountsFile(env: NodeJS.ProcessEnv = process.env): string {
  return storePath('accounts', env);
}

/**
 * One registered account.
 *
 * `tokenFile` is a PATH, never contents — see the module header. `accountId`
 * is Spotify's own pseudoanonymous immutable id, which is what makes it the
 * right key: `id` is the per-account user id, and the docs are explicit that
 * `account_id` is the field to use "for account linking rather than the `id`
 * field, as it is stable and will not change over the lifetime of the account".
 */
export interface AccountEntry {
  /** Spotify's `account_id` from `/me`. The registry key. */
  accountId: string;
  /** The local profile name, i.e. what `--profile <name>` takes. */
  profile: string;
  /**
   * Absolute path of the token file this account authenticates with. Resolved
   * through `getTokenFile`, so it is the SAME file the server would use for
   * that profile — never a second opinion about where tokens live.
   */
  tokenFile: string;
  /** `display_name` at registration time, when `/me` was reachable. */
  displayName?: string;
  /** Space-separated scope string as stored in the token file, if any. */
  scopes?: string;
  /** Epoch ms of the last time this account became the acting one. */
  lastUsed?: number;
}

/**
 * The registry document. `version` is here so a future format change has
 * something to branch on rather than inferring from which keys happen to be
 * present.
 */
interface AccountsDocument {
  version: 1;
  accounts: AccountEntry[];
}

const EMPTY_DOCUMENT: AccountsDocument = { version: 1, accounts: [] };

/**
 * What `list_accounts` returns, and the only shape account data leaves this
 * module in.
 *
 * This is the structural half of the isolation guarantee: the type has no
 * field that could hold token material, so a tool returning it cannot leak a
 * token even if a future edit adds a careless line upstream. It carries the
 * token file PATH because the doctor already discloses it and an operator
 * needs to know which file backs an account — but a path is a name, not a
 * credential.
 */
export interface AccountSummary {
  account_id: string;
  profile: string;
  display_name: string | null;
  token_file: string;
  scopes: string | null;
  last_used: string | null;
  /** True for the account this session is currently acting as. */
  active: boolean;
}

function isAccountEntry(value: unknown): value is AccountEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.accountId === 'string' && entry.accountId !== ''
    && typeof entry.profile === 'string' && entry.profile !== ''
    && typeof entry.tokenFile === 'string' && entry.tokenFile !== '';
}

/**
 * Parse a registry document, dropping anything malformed rather than refusing
 * the whole file.
 *
 * A single bad entry must not make every account invisible — that is the
 * "one row that could not be read took the whole listing down with it" failure
 * the repo already has a name for (#803, and §6's "a correctly named field can
 * still lie about its value"). A file that is not JSON at all IS a refusal:
 * there is no honest partial answer, and silently replacing it would discard
 * every registration the operator has.
 */
function parseDocument(raw: string, file: string): AccountsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Account registry at ${file} is not valid JSON — refusing to overwrite it. `
      + 'Fix or remove the file by hand; nothing has been changed.',
      { cause: err },
    );
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `Account registry at ${file} is not an object — refusing to overwrite it. `
      + 'Fix or remove the file by hand; nothing has been changed.',
    );
  }
  const accounts = (parsed as { accounts?: unknown }).accounts;
  if (accounts === undefined) return { ...EMPTY_DOCUMENT };
  if (!Array.isArray(accounts)) {
    throw new Error(`Account registry at ${file} has a non-array "accounts" — refusing to overwrite it.`);
  }
  return { version: 1, accounts: accounts.filter(isAccountEntry) };
}

/** Read the registry. A missing file is an empty registry, not an error. */
export function readAccounts(env: NodeJS.ProcessEnv = process.env): AccountEntry[] {
  const file = accountsFile(env);
  let raw: string;
  try {
    // Through the local-read guard (#623): the registry is a server-owned
    // store, so the allowed root is its own directory — `ownStoreRoots`, the
    // same helper `loadTokens` uses, so there is one definition of where a
    // server-owned store may be read from. A FIFO planted there must not hang
    // the server, and an oversized file must not be buffered.
    raw = readLocalFileSync({ roots: ownStoreRoots(file), tool: 'accounts', target: file });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (isGuardRefusal(err)) return [];
    throw err;
  }
  return parseDocument(raw, file).accounts;
}

/**
 * A refusal from the read guard, which reports "no readable file at ..." as its
 * own message rather than an errno. Those are the "there is nothing here yet"
 * cases; anything else is a real failure and propagates.
 */
function isGuardRefusal(err: unknown): boolean {
  return err instanceof Error
    && (err.message.startsWith('accounts: no readable file at')
      || err.message.startsWith('accounts: refusing to read'));
}

/**
 * Persist the registry atomically, owner-only (#109's discipline applied to a
 * second file).
 *
 * Mode 0600 on the file and 0700 on its directory, and the mode is re-asserted
 * after the rename because the directory may predate this module with looser
 * bits. A temp file in the same directory keeps the rename atomic (a
 * cross-device rename is not, and the alternative — writing in place — is the
 * truncated-registry failure #109 closed).
 */
export async function writeAccounts(
  accounts: readonly AccountEntry[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const file = accountsFile(env);
  const directory = dirname(resolve(file));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700).catch(() => undefined);
  }
  const document: AccountsDocument = { version: 1, accounts: [...accounts] };
  const temporary = join(directory, `.accounts.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(temporary, 0o600).catch(() => undefined);
  }
  await rename(temporary, file);
  return file;
}

/**
 * Upsert one account, keyed by `account_id`.
 *
 * A re-registration of the same account REPLACES the entry rather than
 * appending: the point of the key is that it identifies an account, and two
 * rows claiming the same `account_id` would make "which token file does this
 * account use" ambiguous — the exact cross-account ambiguity the registry
 * exists to remove. `lastUsed` is the caller's to set; registration does not
 * invent it, because "when did this account last act" is a fact about acting,
 * not about being written down.
 */
export function upsertAccount(accounts: readonly AccountEntry[], entry: AccountEntry): AccountEntry[] {
  const next = accounts.filter((existing) => existing.accountId !== entry.accountId);
  next.push(entry);
  return next;
}

/** Remove one account by `account_id`. Returns the new list either way. */
export function removeAccount(accounts: readonly AccountEntry[], accountId: string): AccountEntry[] {
  return accounts.filter((entry) => entry.accountId !== accountId);
}

// ---------------------------------------------------------------------------
// The acting account
// ---------------------------------------------------------------------------

/**
 * The identity of the account the session is acting as, resolved from a live
 * `/me` the first time it is needed.
 *
 * `account_id` and `display_name` cannot be read from a token file, and a
 * `/me` on the path of every tool call would be a request per call. So it is
 * resolved once per acting account and reused — but it is stored TOGETHER WITH
 * the token file it was read for, and a getter that only hands it back while
 * that file is still the acting one.
 *
 * Carrying the file is the whole design. A separate "clear this on switch"
 * instruction is a thing to forget: forget it and the previous account's name
 * is reported against the current one, which is a wrong answer in the one
 * place an operator looks to find out which account they are on. Here a switch
 * invalidates the value without anyone having to remember to.
 */
let actingIdentity: {
  tokenFile: string;
  accountId: string;
  displayName: string | null;
} | undefined;

export function rememberActingIdentity(
  tokenFile: string,
  identity: { accountId: string; displayName: string | null },
): void {
  actingIdentity = { tokenFile, accountId: identity.accountId, displayName: identity.displayName };
}

/**
 * The acting identity, but only while `tokenFile` is still the account it was
 * read for. Anything else returns undefined, which callers report as "not
 * resolved yet" and re-read — never as a blank name.
 */
export function currentActingIdentity(tokenFile: string): { accountId: string; displayName: string | null } | undefined {
  if (!actingIdentity || actingIdentity.tokenFile !== tokenFile) return undefined;
  return { accountId: actingIdentity.accountId, displayName: actingIdentity.displayName };
}

/**
 * Drop every cached, in-process account decision.
 *
 * For tests between cases. The registry FILE is untouched — this is session
 * state only, so a test that switches accounts cannot leak that choice into the
 * next one. Production code does not need to call it: {@link
 * currentActingIdentity} is already keyed by token file.
 */
export function resetActingAccount(): void {
  actingIdentity = undefined;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * Project an entry to the wire shape. This is the ONLY way account data leaves
 * the module, and the target type has no field that can hold a token.
 */
export function toSummary(entry: AccountEntry, activeTokenFilePath: string): AccountSummary {
  return {
    account_id: entry.accountId,
    profile: entry.profile,
    display_name: entry.displayName ?? null,
    token_file: entry.tokenFile,
    scopes: entry.scopes ?? null,
    last_used: entry.lastUsed ? new Date(entry.lastUsed).toISOString() : null,
    active: entry.tokenFile === activeTokenFilePath,
  };
}

/**
 * The profile name a token file corresponds to, or undefined for the default.
 *
 * DERIVED from the path rather than from the registry, so it cannot disagree
 * with where tokens actually live. This is the same derivation
 * `cacheFileNameFor` performs in the read direction (#1249): a second,
 * hand-rolled profile lookup is precisely how the cache came to ignore
 * `--profile`, and the inverse mistake here would register an account under a
 * profile name that does not select its own file.
 */
export function profileForTokenFile(tokenFile: string): string | undefined {
  const name = basename(tokenFile);
  if (name === 'tokens.json') return undefined;
  if (name.startsWith('tokens.') && name.endsWith('.json')) {
    return name.slice('tokens.'.length, -'.json'.length);
  }
  // A custom SPOTIFY_MCP_TOKEN_FILE has no profile name; the caller supplies
  // one explicitly at registration rather than this function inventing one.
  return undefined;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * The subset of `/me` this module reads. `account_id` is optional at the type
 * level because a registration older than Spotify's field — or a payload from
 * a registration that does not send it — must not be coerced into a plausible
 * value. §6: a field that could not be read is reported as unreadable, never
 * guessed.
 */
export interface MeIdentity {
  id?: string;
  account_id?: string;
  display_name?: string | null;
}

/** The outcome of registering one account. */
export interface RegisterResult {
  entry: AccountEntry;
  /** True when this call created the entry rather than replacing one. */
  created: boolean;
  /**
   * Why the identity could not be read, when it could not. The entry is still
   * written — the token file is real and the profile is named — but a caller
   * that needs `account_id` must be told it is missing rather than shown a
   * stand-in.
   */
  identityUnavailable?: string;
}

/**
 * Register the account a token file belongs to.
 *
 * `identity` is whatever the caller managed to read from `/me`. It is passed
 * IN rather than fetched here so that registration never performs I/O of its
 * own: its one caller — `switch_account`, the only writer of this file — is
 * already holding an authenticated response, and a module that quietly issued
 * its own request would be a second way for the session to reach the network.
 *
 * `spotify-mcp auth --profile` is NOT a second writer. It creates the token
 * file a profile is named by, and never reaches this function; a profile is
 * not in the registry until something switches to it (#1465).
 *
 * When `/me` did not carry `account_id`, the entry is keyed by the user's `id`
 * and flagged — a real, stable key, honestly labelled, rather than a refusal
 * that would leave a genuinely authenticated account unregistered.
 */
export function registerAccount(input: {
  profile: string;
  tokenFile: string;
  identity: MeIdentity | undefined;
  tokens?: Pick<TokenData, 'scope'>;
  lastUsed?: number;
}, existing: readonly AccountEntry[]): RegisterResult {
  const accountId = input.identity?.account_id ?? input.identity?.id;
  if (!accountId) {
    // The remediation names the ONE thing that writes this file. It used to
    // name `spotify-mcp auth --profile`, which creates a token file and never
    // reaches this function: following that advice exits 0, writes a plausible
    // token, and leaves the registry empty, so no state ever satisfies it
    // (#1465). A message a reader cannot act on is worse than no remediation.
    throw new Error(
      `Cannot register profile "${input.profile}": /me returned neither account_id nor id, `
      + 'so the account has no stable key. The profile is authenticated and the session is '
      + 'acting as it — only its registry entry is missing, and switch_account is the only '
      + 'thing that writes one — so re-run switch_account for this profile once /me serves '
      + 'either field.',
    );
  }
  const created = !existing.some((entry) => entry.accountId === accountId);
  const entry: AccountEntry = {
    accountId,
    profile: input.profile,
    tokenFile: input.tokenFile,
    ...(input.identity?.display_name ? { displayName: input.identity.display_name } : {}),
    ...(input.tokens?.scope ? { scopes: input.tokens.scope } : {}),
    ...(input.lastUsed !== undefined ? { lastUsed: input.lastUsed } : {}),
  };
  return {
    entry,
    created,
    ...(input.identity?.account_id ? {} : {
      identityUnavailable:
        'Spotify did not return account_id on this registration; the entry is keyed by the '
        + 'account user id instead, which is stable but is not the field Spotify documents '
        + 'for account linking.',
    }),
  };
}

/**
 * Token files on disk that could belong to an account.
 *
 * Enumeration exists so `switch_account` can name a profile the operator
 * created with `auth --profile` and has not yet registered — the common case,
 * since the registry is populated by the acts that use it. Only the two shapes
 * this server writes are considered: `tokens.json` and `tokens.<profile>.json`.
 * A `.pending` marker or a temp file from an interrupted write is not an
 * account, and admitting one would offer to switch to a file that cannot
 * authenticate.
 */
export async function discoverTokenFiles(activeFile: string): Promise<string[]> {
  // The directory of the ACTIVE token file, so a relocated home relocates the
  // sweep with it — the same reasoning that makes every other per-account
  // store follow `getTokenFile`. The caller passes the file rather than this
  // re-deriving one: the client's is authoritative after a switch, and a second
  // resolution here is a second answer to the same question.
  const directory = dirname(resolve(activeFile));
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names
    .filter((name) => name === 'tokens.json' || (/^tokens\.[A-Za-z0-9._-]+\.json$/).test(name))
    .sort()
    .map((name) => join(directory, name));
}

/**
 * Whether a token file holds usable credentials, WITHOUT reading them out.
 *
 * A boolean, deliberately. The question this answers is "can this be switched
 * to", and the answer is not an invitation to hold the value: a predicate that
 * returned the token would make every caller a holder. `isTokenData` reads
 * the file and keeps nothing.
 */
export function tokenFileIsUsable(tokenFile: string): boolean {
  try {
    return isTokenData(JSON.parse(readTokenFileForShape(tokenFile)));
  } catch {
    return false;
  }
}

function readTokenFileForShape(tokenFile: string): string {
  return readLocalFileSync({
    roots: ownStoreRoots(tokenFile),
    tool: 'accounts',
    target: tokenFile,
  });
}
