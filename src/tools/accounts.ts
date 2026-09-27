/**
 * `list_accounts` and `switch_account` (#602).
 *
 * The two tools that make "which account am I acting as" answerable at call
 * time. Everything else in this repo already resolves ONE token file per
 * process; this module is the part that lets a session change which one, and
 * the part that makes the change legible to a caller who did not make it.
 *
 * ## The two rules this file is built around
 *
 * **A listing is an identity, never a credential.** `list_accounts` returns
 * `AccountSummary` rows — `account_id`, `profile`, `display_name`, the token
 * file PATH, scopes, and a flag. There is no field on that type that can hold
 * a token, so the guarantee is structural rather than a matter of remembering
 * to redact. The path is included deliberately: the doctor already discloses
 * it, the operator named it on the command line, and an operator debugging a
 * switch needs to know which file backs an account. A path is a name; the
 * bytes behind it are the secret, and nothing here reads them out.
 *
 * **A switch is a write, and it is confirmed.** Changing the acting account
 * changes whose library every subsequent mutation lands in, and the previous
 * account's session state is not restored by the tool that left it. So
 * `switch_account` states `destructiveHint` explicitly, asks through
 * elicitation with no threshold (the count-based gates in `confirm.ts` measure
 * how MANY things a call destroys; this destroys one account's session and no
 * amount of accumulation makes that safer), and the gate fails closed through
 * `requiredConfirmationRefusal` exactly like every other one. `SPOTIFY_MCP_CONFIRM=never`
 * remains the only bypass.
 *
 * ## Why switching does more than re-point one string
 *
 * `SpotifyClient.switchAccount` is where the isolation property actually lives;
 * this module calls it. The two things that make it non-trivial are the read
 * cache, which is keyed by request and not by account, and the queue, which can
 * hold a request that already passed the token check. Both are handled there
 * and neither is duplicated here.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../client.js';
import { getTokenFile, loadTokens } from '../auth.js';
import {
  accountsFile,
  currentActingIdentity,
  discoverTokenFiles,
  profileForTokenFile,
  readAccounts,
  registerAccount,
  rememberActingIdentity,
  toSummary,
  tokenFileIsUsable,
  upsertAccount,
  writeAccounts,
  type AccountSummary,
  type MeIdentity,
} from '../accounts.js';
import { confirmViaElicitation, describeConfirmation, requiredConfirmationRefusal } from './confirm.js';
import { ResponseFormat } from '../shaping.js';
import type { UserProfile } from '../types/spotify.js';

type ToolOut = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown> };

function textResult(text: string, structured?: Record<string, unknown>): ToolOut {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}) };
}

function emit(fmt: string | undefined, structured: Record<string, unknown>, text: string): ToolOut {
  if (fmt === 'json') {
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
  }
  return textResult(text, structured);
}

/**
 * The profile name that means "the account the server started as".
 *
 * `--profile default` is a real file (`tokens.default.json`), not the default
 * account, so the name cannot be resolved by handing it to `getTokenFile` —
 * that would offer to switch to an account that does not exist. The registry
 * stores the default account under this label and carries its RESOLVED token
 * file, so the switch uses the entry's path rather than re-deriving one.
 */
const DEFAULT_PROFILE = 'default';

/**
 * Resolve a profile name to the token file it authenticates with.
 *
 * A registered account answers from its stored path. An unregistered one is
 * resolved through `getTokenFile` — the same resolver the server itself uses,
 * so `switch_account("work")` selects exactly the file `--profile work` would
 * have selected at startup. That is the point of going through it rather than
 * building a filename here: a second, hand-rolled profile-to-path function is
 * how the persisted cache came to disagree with the token file (#1249).
 */
function resolveProfile(profile: string): { tokenFile: string; registered: boolean } {
  if (profile === DEFAULT_PROFILE) return { tokenFile: getTokenFile(undefined), registered: false };
  return { tokenFile: getTokenFile(profile), registered: true };
}

/**
 * Read the acting account's identity from `/me`, and cache it for the session.
 *
 * Returns undefined rather than a blank when the read fails or the payload
 * carries no usable id: a caller must be able to tell "this account has no
 * known identity" from "this account is called nothing", and §6's rule is
 * that a value which could not be read is never coerced into a plausible one.
 */
async function readActingIdentity(client: SpotifyClient): Promise<{ accountId: string; displayName: string | null } | undefined> {
  const tokenFile = client.tokenFile;
  const cached = currentActingIdentity(tokenFile);
  if (cached) return cached;
  let profile: MeIdentity | undefined;
  try {
    profile = (await client.get<UserProfile>('/me')) ?? undefined;
  } catch {
    // A failed /me must not fail the listing. The account is still acting; it
    // is the display name that is missing, and that is reported as missing.
    return undefined;
  }
  const accountId = profile?.account_id ?? profile?.id;
  if (!accountId) return undefined;
  const identity = { accountId, displayName: profile?.display_name ?? null };
  rememberActingIdentity(tokenFile, identity);
  return identity;
}

/**
 * Every account this box can act as, as `AccountSummary` rows with exactly one
 * flagged `active`.
 *
 * The acting account is guaranteed a row even when the registry has never seen
 * it — which is the normal state of a server started with `--profile work` that
 * has not switched since. Without that, a freshly started session would list
 * nothing at all and report no active account, which is the one answer a
 * caller is guaranteed to want.
 */
async function collectAccounts(client: SpotifyClient): Promise<{ accounts: AccountSummary[]; registryPath: string }> {
  const entries = readAccounts();
  const activeTokenFile = client.tokenFile;
  const identity = await readActingIdentity(client);

  const accounts = entries.map((entry) => toSummary(entry, activeTokenFile));
  const actingIsListed = accounts.some((row) => row.active);
  if (!actingIsListed) {
    // Unregistered, so the honest row says so rather than implying the registry
    // knows something it does not. `token_file` and `account_id` are the facts
    // that were read; `display_name` is null when /me could not be reached.
    accounts.unshift({
      account_id: identity?.accountId ?? '',
      profile: profileForTokenFile(activeTokenFile) ?? DEFAULT_PROFILE,
      display_name: identity?.displayName ?? null,
      token_file: activeTokenFile,
      scopes: null,
      last_used: null,
      active: true,
    });
  }
  return { accounts, registryPath: accountsFile() };
}

/** Prose for `list_accounts`, kept in step with the structured rows. */
function renderAccountList(accounts: AccountSummary[], registryPath: string): string {
  if (accounts.length === 0) {
    return `No accounts registered. Registry: ${registryPath}. `
      + 'Run "spotify-mcp auth --profile <name>" to add one.';
  }
  const lines = [`${accounts.length} account(s) — acting as:`, ''];
  for (const account of accounts) {
    const name = account.display_name ?? '(display name unavailable)';
    const mark = account.active ? '*' : ' ';
    const id = account.account_id || '(not resolved)';
    const scopes = account.scopes ? ` scopes=${account.scopes}` : '';
    lines.push(`${mark} ${account.profile} — ${name} [${id}]`);
    lines.push(`    token file: ${account.token_file}${scopes}`);
    if (account.last_used) lines.push(`    last used:  ${account.last_used}`);
  }
  return `${lines.join('\n')}\n\n* = acting account`;
}

export function registerAccountsTools(server: McpServer, client: SpotifyClient): void {
  server.tool(
    'list_accounts',
    'List every local account this server can act as, and which one it is acting as now. '
    + 'Returns each account\'s account_id, profile name, display name and token file PATH — '
    + 'never any token material. Reads the local registry and one GET /me for the acting account; '
    + 'no mutation requests are issued.',
    {
      response_format: ResponseFormat,
    },
    async (args) => {
      const { accounts, registryPath } = await collectAccounts(client);
      const acting = accounts.find((row) => row.active) ?? null;
      const structured = {
        accounts,
        active_account_id: acting?.account_id || null,
        active_display_name: acting?.display_name ?? null,
        active_token_file: client.tokenFile,
        registry_file: registryPath,
      };
      return emit(
        args.response_format,
        structured,
        renderAccountList(accounts, registryPath),
      );
    },
  );

  server.tool(
    'switch_account',
    'Change which registered account this session acts as. Takes effect for every subsequent call '
    + 'in this session: the client re-points its token file, drops the previous account\'s cached '
    + 'reads and validators, and refuses to switch while a request is in flight. Asks for '
    + 'confirmation first, because every later write then lands in the new account\'s library. '
    + 'Changes local session state and the account registry only — it issues no Spotify writes.',
    {
      profile: z
        .string()
        .min(1)
        .describe(
          'Profile name to act as — the same value "--profile <name>" takes, or "default" for the '
          + 'account this server started as. The name must already have been authenticated with '
          + '"spotify-mcp auth --profile <name>"; this tool does not run the auth flow.',
        ),
      response_format: ResponseFormat,
    },
    async (args) => {
      const profile = args.profile.trim();

      // No threshold: one switch changes whose library every later write
      // touches, and that is true of a switch to one account exactly as much
      // as of a bulk change.
      const verdict = await confirmViaElicitation(server, {
        message: describeConfirmation(
          'switch the acting account to',
          profile,
          [
            'Every subsequent call in this session — including writes — will act as this account.',
            'The account this session is acting as now keeps its registry entry; nothing on Spotify is changed.',
            'No other account\'s saved data becomes reachable, and this account\'s does not become reachable to the other.',
          ],
        ),
        confirmLabel: `Act as "${profile}"`,
      });
      const refusal = requiredConfirmationRefusal(verdict);
      if (refusal) return textResult(refusal.message, refusal.payload);

      const registry = readAccounts();
      const registered = registry.find((entry) => entry.profile === profile);
      // A registered entry carries the path it was resolved with; an
      // unregistered name goes through the server's own resolver so it selects
      // exactly the file `--profile <name>` would have. Either way the answer
      // comes from one function, not two.
      const target = registered?.tokenFile ?? resolveProfile(profile).tokenFile;

      if (target === client.tokenFile) {
        return emit(
          args.response_format,
          { ok: true, changed: false, profile, token_file: target, acting_account_id: null },
          `Already acting as "${profile}" (${target}); nothing changed.`,
        );
      }
      if (!tokenFileIsUsable(target)) {
        return textResult(
          `Cannot switch to "${profile}": ${target} holds no usable Spotify credentials. `
          + `Run "spotify-mcp auth --profile ${profile}" first.`,
          { ok: false, changed: false, profile, token_file: target, reason: 'no_credentials' },
        );
      }

      // Drain before switching. A request that already passed the token check
      // would finish against the new account and write its response into the
      // new account's cache — the same cross-account leak with an extra step.
      await client.drainPendingRequests();
      await client.switchAccount(target);

      // Register from a live /me under the NEW account, and record the moment
      // it started acting. The scopes come from the token file itself, read
      // only for the `scope` string: nothing token-shaped is kept.
      let registered2: ReturnType<typeof registerAccount> | undefined;
      let failure: string | undefined;
      try {
        const me = (await client.get<UserProfile>('/me')) ?? undefined;
        const tokens = await loadTokens(target).catch(() => undefined);
        const result = registerAccount({
          profile,
          tokenFile: target,
          identity: me,
          ...(tokens?.scope ? { tokens: { scope: tokens.scope } } : {}),
          lastUsed: Date.now(),
        }, registry);
        await writeAccounts(upsertAccount(registry, result.entry));
        registered2 = result;
        if (result.entry.accountId) {
          rememberActingIdentity(target, {
            accountId: result.entry.accountId,
            displayName: result.entry.displayName ?? null,
          });
        }
      } catch (err) {
        // The SWITCH already happened and is not being undone: the session is
        // genuinely acting as the new account. What failed is the bookkeeping,
        // and reporting that as a failed switch would be a lie about the state
        // the session is in.
        failure = err instanceof Error ? err.message : String(err);
      }

      const summary: AccountSummary = {
        // An empty string, not a stand-in, when /me could not be read: the
        // switch happened and its identity is unknown, and those are two
        // facts the caller can act on differently (§6).
        account_id: registered2?.entry.accountId ?? '',
        profile,
        display_name: registered2?.entry.displayName ?? null,
        token_file: target,
        scopes: registered2?.entry.scopes ?? null,
        last_used: new Date().toISOString(),
        active: true,
      };
      const structured = {
        ok: true,
        changed: true,
        profile,
        token_file: target,
        acting_account_id: summary.account_id || null,
        acting_display_name: summary.display_name,
        registry_file: accountsFile(),
        ...(registered2?.identityUnavailable ? { identity_note: registered2.identityUnavailable } : {}),
        ...(failure ? { registration_warning: failure } : {}),
      };
      return emit(
        args.response_format,
        structured,
        [
          `Now acting as "${profile}"${summary.display_name ? ` (${summary.display_name})` : ''}.`,
          `Token file: ${target}`,
          'The previous account\'s cached reads and validators were dropped, so nothing it read is served here.',
          ...(failure ? [`Note: the registry could not be updated — ${failure}`] : []),
        ].join('\n'),
      );
    },
  );
}
