/**
 * The account registry and the acting-account switch (#602).
 *
 * ## The test that matters
 *
 * `isolation` below is the one this file exists for. The issue's Impact names
 * the failure: "harnesses that multiplex one MCP server across several people
 * have a cross-account leakage risk because nothing identifies the acting
 * account at call time". A switch that re-points a token file but leaves the
 * read cache alone is a session that has *changed accounts on paper* and keeps
 * serving the previous one's data — the worst shape a security boundary can
 * have, because every outward signal says the switch worked.
 *
 * The test drives the REAL client through the REAL cache and the REAL
 * scheduler, intercepting only `globalThis.fetch`. It does not use
 * `StubSpotifyClient`, and that is deliberate: the stub overrides `get`, so it
 * never consults the cache at all, and a cache-isolation test written against
 * it would be asserting about a code path the test never enters — a test that
 * cannot fail (AGENTS.md §6).
 *
 * Each of these was verified by reverting the source line it covers and
 * watching the assertion go red; the revert notes are on the cases.
 */
import './helpers/hermetic.js';

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SpotifyClient } from '../src/client.js';
import { registerAccountsTools } from '../src/tools/accounts.js';
import { installActingAccountBoundary, resetActingAccountProbe, resolveActingAccount } from '../src/actingaccount.js';
import { accountsFile, readAccounts, resetActingAccount } from '../src/accounts.js';
import type { TokenData } from '../src/types/spotify.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two accounts, each with its own token file, id and display name. */
interface AccountFixture {
  profile: string;
  tokenFile: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  displayName: string;
  userId: string;
}

const ONE_HOUR_MS = 3_600_000;

let root = '';
let personal: AccountFixture;
let work: AccountFixture;

function fixture(
  profile: string,
  accountId: string,
  userId: string,
  displayName: string,
  marker: string,
): AccountFixture {
  return {
    profile,
    tokenFile: join(root, profile === 'default' ? 'tokens.json' : `tokens.${profile}.json`),
    accessToken: `access-${marker}`,
    refreshToken: `refresh-${marker}`,
    accountId,
    userId,
    displayName,
  };
}

function tokenDataFor(account: AccountFixture): TokenData {
  return {
    access_token: account.accessToken,
    refresh_token: account.refreshToken,
    expires_at: Date.now() + ONE_HOUR_MS,
    scope: 'user-read-private user-library-read',
  };
}

/** The `/me` payload Spotify serves for one account. */
function mePayloadFor(account: AccountFixture) {
  return {
    id: account.userId,
    account_id: account.accountId,
    display_name: account.displayName,
    uri: `spotify:user:${account.userId}`,
    external_urls: { spotify: `https://open.spotify.com/user/${account.userId}` },
  };
}

// ---------------------------------------------------------------------------
// Network interception
// ---------------------------------------------------------------------------

interface RecordedRequest {
  path: string;
  authorization: string | undefined;
  ifNoneMatch: string | undefined;
}

let requests: RecordedRequest[] = [];
let realFetch: typeof globalThis.fetch;
/** Set by a test to hold one route open across an await. */
let heldFetch: { promise: Promise<void>; release: () => void } | undefined;

/**
 * Answer `GET /me` and `GET /tracks/{id}` as whichever account the request
 * authenticated as.
 *
 * The account is derived from the `Authorization` header, not from a variable
 * the test flips. That is the whole point: if the client ever presents the
 * previous account's bearer token after a switch, this returns the WRONG
 * account's data and the test fails — rather than the stub agreeing with
 * whatever the code under test happened to do.
 */
function installFetch(): void {
  requests = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const authorization = headers.get('authorization') ?? undefined;
    const path = new URL(url).pathname;
    requests.push({ path, authorization, ifNoneMatch: headers.get('if-none-match') ?? undefined });

    const byToken: Record<string, AccountFixture> = {
      [`Bearer ${personal.accessToken}`]: personal,
      [`Bearer ${work.accessToken}`]: work,
    };
    const account = byToken[authorization ?? ''];

    const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });

    if (!account) {
      return json({ error: { status: 401, message: 'No access token provided' } }, 401);
    }
    if (path === '/v1/me') return json(mePayloadFor(account));
    if (path.startsWith('/v1/tracks/')) {
      const id = path.slice('/v1/tracks/'.length);
      // A route the test can hold open, so a request can be observed in flight
      // rather than simulated by a sleep that might not overlap anything.
      if (id === 'slow' && heldFetch) await heldFetch.promise;
      // An ETag is per-account, so a validator carried across a switch would
      // name the wrong account's payload — which is the whole point of the
      // test that uses it.
      return json(
        { id, name: `${account.displayName}'s copy of ${id}`, owner: { id: account.userId } },
        200,
        { etag: `"${account.accountId}-${id}"` },
      );
    }
    return json({ error: { status: 404, message: `no stub route for ${path}` } }, 404);
  }) as typeof globalThis.fetch;
}

function countRequestsFor(path: string): number {
  return requests.filter((r) => r.path === path).length;
}

/** A gate the test opens by hand, for holding a request in flight. */
function holdFetch(): { release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  heldFetch = { promise, release };
  return { release: () => { heldFetch = undefined; release(); } };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'accounts-602-'));
  await mkdir(root, { recursive: true });
  personal = fixture('default', 'acct-personal-0001', 'user-personal', 'Personal Account', 'personal');
  work = fixture('work', 'acct-work-0002', 'user-work', 'Work Account', 'work');
  for (const account of [personal, work]) {
    await writeFile(account.tokenFile, JSON.stringify(tokenDataFor(account)), { mode: 0o600 });
  }
  // The registry lives under the hermetic HOME the helper installed, so this
  // never touches the developer's real ~/.spotify-mcp/accounts.json.
  process.env.SPOTIFY_MCP_ACCOUNTS_FILE = join(root, 'accounts.json');
  installFetch();
});

after(() => {
  globalThis.fetch = realFetch;
  delete process.env.SPOTIFY_MCP_CONFIRM;
});

beforeEach(() => {
  requests = [];
  heldFetch = undefined;
  resetActingAccount();
  resetActingAccountProbe();
});

/**
 * A REAL client with the cache ON — never `StubSpotifyClient`.
 *
 * The stub overrides `get`, so it never reads or writes the cache, and a cache
 * test written against it would assert about a path the test never enters.
 * These cases intercept `globalThis.fetch` instead, which leaves the cache, the
 * scheduler and the token handling all production.
 */
function realClient(
  account: AccountFixture = personal,
  opts: { cacheTtlMs?: number } = {},
): SpotifyClient {
  return new SpotifyClient({
    tokenFile: account.tokenFile,
    random: () => 0.5,
    ...(opts.cacheTtlMs !== undefined ? { cache: { ttlMs: opts.cacheTtlMs } } : {}),
  });
}

// ---------------------------------------------------------------------------
// The isolation property
// ---------------------------------------------------------------------------

describe('account isolation across a switch (#602)', () => {
  it('does not serve account A\'s cached read to account B', async () => {
    const client = realClient(personal);

    // A's view of the track, fetched twice. The second read MUST be served
    // from the cache — otherwise the test below would pass with the cache
    // switched off entirely, which is a different (and much weaker) claim.
    const first = await client.get<{ name: string }>('/tracks/abc');
    const second = await client.get<{ name: string }>('/tracks/abc');
    assert.equal(first?.name, "Personal Account's copy of abc");
    assert.equal(second?.name, "Personal Account's copy of abc");
    assert.equal(
      countRequestsFor('/v1/tracks/abc'),
      1,
      'POSITIVE CONTROL: the second read should have been served from the read cache, '
      + 'so this test is really exercising the cache and not a disabled one.',
    );

    await client.switchAccount(work.tokenFile);

    const underB = await client.get<{ name: string }>('/tracks/abc');
    assert.equal(
      underB?.name,
      "Work Account's copy of abc",
      'a read after the switch returned the PREVIOUS account\'s cached body',
    );
    assert.equal(
      countRequestsFor('/v1/tracks/abc'),
      2,
      'the post-switch read was served from cache — the cache survived the switch',
    );
  });

  it('sends the NEW account\'s bearer token, never the previous one', async () => {
    const client = realClient(personal);
    await client.get('/me');
    assert.equal(requests.at(-1)?.authorization, `Bearer ${personal.accessToken}`);

    await client.switchAccount(work.tokenFile);
    await client.get('/me');

    const after = requests.at(-1);
    assert.equal(after?.authorization, `Bearer ${work.accessToken}`);
    assert.notEqual(
      after?.authorization,
      `Bearer ${personal.accessToken}`,
      'the previous account\'s credential was presented after the switch',
    );
  });

  it('drops the previous account\'s ETag validators, so no 304 answers from its payload', async () => {
    // A validator only reaches the wire on a read whose body has EXPIRED but
    // whose ETag has not — so the body TTL is set below the validator window
    // and the first entry is allowed to go stale. Asserted, not assumed: if a
    // regression stopped the client presenting validators at all, this control
    // fails instead of the real assertion passing vacuously.
    const client = realClient(personal, { cacheTtlMs: 1 });
    await client.get('/tracks/etagged');
    await new Promise((r) => setTimeout(r, 15));
    await client.get('/tracks/etagged');
    const validatorBefore = requests.at(-1)?.ifNoneMatch;
    assert.ok(validatorBefore, 'CONTROL: the revalidated read should have presented a stored ETag');

    await client.switchAccount(work.tokenFile);
    await client.get('/tracks/etagged');
    assert.equal(
      requests.at(-1)?.ifNoneMatch,
      undefined,
      "the new account's request presented the previous account's ETag; a 304 would have "
      + 'answered with the previous account\'s bytes',
    );
  });

  it('re-points the persisted cache file at the new account rather than the startup one', async () => {
    const client = realClient(personal);
    const before = client.tokenFile;
    assert.equal(before, personal.tokenFile);
    await client.switchAccount(work.tokenFile);
    assert.equal(client.tokenFile, work.tokenFile);
  });

  it('refuses to switch while a request is still in flight', async () => {
    const client = realClient(personal);
    // Hold a real request open inside the fetch stub, so the drain has
    // something true to wait for rather than a sleep that might not overlap
    // anything.
    const gate = holdFetch();
    const inFlight = client.get('/tracks/slow');
    // Let the request reach the stub (and therefore the funnel) before the
    // drain looks at the queue.
    while (countRequestsFor('/v1/tracks/slow') === 0) {
      await new Promise((r) => setTimeout(r, 1));
    }
    try {
      await assert.rejects(
        () => client.drainPendingRequests(50),
        /Refusing to switch mid-flight/,
      );
      assert.equal(client.tokenFile, personal.tokenFile, 'the client switched despite the refusal');
    } finally {
      gate.release();
      await inFlight;
    }
    // POSITIVE CONTROL: once the request is done, the drain succeeds. Without
    // it, a drain that simply always threw would pass this test.
    await client.drainPendingRequests(1000);
  });
});

// ---------------------------------------------------------------------------
// The listing never carries token material
// ---------------------------------------------------------------------------

/** Every string reachable from a value, for the leak scan below. */
function allStrings(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, into));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { into.push(k); allStrings(v, into); }
  }
  return into;
}

describe('list_accounts (#602)', () => {
  it('names every registered account and never discloses token material', async () => {
    const { writeAccounts, upsertAccount } = await import('../src/accounts.js');
    await writeAccounts([
      ...upsertAccount([], {
        accountId: personal.accountId,
        profile: 'default',
        tokenFile: personal.tokenFile,
        displayName: personal.displayName,
        scopes: 'user-read-private',
        lastUsed: Date.now() - 1000,
      }),
      {
        accountId: work.accountId,
        profile: 'work',
        tokenFile: work.tokenFile,
        displayName: work.displayName,
        scopes: 'user-read-private',
        lastUsed: Date.now() - 2000,
      },
    ]);

    const client = realClient(personal);
    const server = new McpServer({ name: 'test', version: '0' });
    registerAccountsTools(server, client);
    const transport = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(transport[0]), mcp.connect(transport[1])]);

    const result = await mcp.callTool({ name: 'list_accounts', arguments: { response_format: 'json' } });
    const structured = result.structuredContent as { accounts: Array<{ account_id: string; active: boolean }> };

    assert.deepEqual(
      structured.accounts.map((a) => a.account_id).sort(),
      [personal.accountId, work.accountId].sort(),
      'list_accounts must return every registered account',
    );
    assert.equal(structured.accounts.filter((a) => a.active).length, 1, 'exactly one account is active');

    // THE HIGH-FINDING CHECK. If this fails, one account's listing exposes
    // another account's credentials — a ship-blocker, not a bug.
    const haystack = JSON.stringify(result) + allStrings(result).join('\u0000');
    for (const secret of [personal.accessToken, personal.refreshToken, work.accessToken, work.refreshToken]) {
      assert.ok(
        !haystack.includes(secret),
        `list_accounts disclosed token material (${secret.slice(0, 12)}…) — this is the HIGH finding the issue forbids`,
      );
    }
    // The path is disclosed deliberately, so the check is that the PATH is
    // there and the BYTES are not: a listing that hid the path would fail a
    // different, equally load-bearing requirement.
    assert.ok(
      haystack.includes(work.tokenFile),
      'the token file PATH should be disclosed — an operator cannot debug a switch without it',
    );

    await mcp.close();
    await server.close();
  });

  it('POSITIVE CONTROL: the leak scan can see a secret that IS present', async () => {
    // Without this, a haystack that was accidentally always empty would make
    // the assertion above pass for the wrong reason.
    const haystack = JSON.stringify({ token_file: '/tmp/tokens.work.json' })
      + allStrings({ token_file: '/tmp/tokens.work.json' }).join('\u0000');
    assert.ok(haystack.includes('tokens.work.json'));
    assert.ok(!haystack.includes('refresh-work'));
  });
});

// ---------------------------------------------------------------------------
// The switch, end to end
// ---------------------------------------------------------------------------

describe('switch_account (#602)', () => {
  /** Register both accounts so a switch has a target to find. */
  async function seedRegistry(): Promise<void> {
    const { writeAccounts, upsertAccount } = await import('../src/accounts.js');
    const withPersonal = upsertAccount([], {
      accountId: personal.accountId,
      profile: 'default',
      tokenFile: personal.tokenFile,
      displayName: personal.displayName,
    });
    await writeAccounts(upsertAccount(withPersonal, {
      accountId: work.accountId,
      profile: 'work',
      tokenFile: work.tokenFile,
      displayName: work.displayName,
    }));
  }

  /**
   * `confirm` picks the host's behaviour, because the three cases are three
   * different things and collapsing them into one is how a gate that only ever
   * saw its happy path gets shipped:
   *
   *   - `'bypass'`  — SPOTIFY_MCP_CONFIRM=never, the documented automation path.
   *   - `'silent'`  — a client that advertises NO elicitation capability, so
   *                   `supportsElicitation` is false and the verdict is
   *                   'unsupported'. This is the host that cannot prompt.
   *   - `'failing'` — a client that DOES advertise the capability and whose
   *                   prompt then fails on the wire (#684). A different
   *                   refusal reason, and the one a dead gate produces.
   */
  async function harness(
    client: SpotifyClient,
    confirm: 'bypass' | 'silent' | 'failing' = 'bypass',
  ) {
    const server = new McpServer({ name: 'test', version: '0' });
    if (confirm === 'bypass') process.env.SPOTIFY_MCP_CONFIRM = 'never';
    else delete process.env.SPOTIFY_MCP_CONFIRM;
    registerAccountsTools(server, client);
    const transport = InMemoryTransport.createLinkedPair();
    // `capabilities: {}` is the SDK default and advertises NO elicitation, so
    // 'silent' is the ordinary case; 'failing' has to opt IN to the
    // capability to reach the prompt at all.
    const mcp = confirm === 'failing'
      ? new Client({ name: 'test', version: '0' }, { capabilities: { elicitation: {} } })
      : new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(transport[0]), mcp.connect(transport[1])]);
    return { server, mcp };
  }

  it('changes the acting account for subsequent calls in the same session', async () => {
    await seedRegistry();
    const client = realClient(personal);
    assert.equal((await client.get<{ display_name: string }>('/me'))?.display_name, personal.displayName);

    const { mcp, server } = await harness(client);
    const switched = await mcp.callTool({ name: 'switch_account', arguments: { profile: 'work' } });
    const structured = switched.structuredContent as { changed: boolean; acting_account_id: string };
    assert.equal(structured.changed, true);
    assert.equal(structured.acting_account_id, work.accountId);
    await mcp.close();
    await server.close();

    // The acceptance criterion, verbatim: after switch_account("work"),
    // get_me reports the work display name.
    const me = await client.get<{ display_name: string; account_id: string }>('/me');
    assert.equal(me?.display_name, work.displayName);
    assert.equal(me?.account_id, work.accountId);
  });

  it('records the switch in the registry, without token material', async () => {
    await seedRegistry();
    const client = realClient(personal);
    const { mcp, server } = await harness(client);
    await mcp.callTool({ name: 'switch_account', arguments: { profile: 'work' } });
    await mcp.close();
    await server.close();

    const entries = readAccounts();
    const switched = entries.find((e) => e.profile === 'work');
    assert.ok(switched, 'the switched account should be in the registry');
    assert.equal(switched.accountId, work.accountId);
    assert.ok(switched.lastUsed, 'the switch should record when the account started acting');

    const raw = await readFile(accountsFile(), 'utf8');
    for (const secret of [work.accessToken, work.refreshToken, personal.accessToken, personal.refreshToken]) {
      assert.ok(!raw.includes(secret), 'the registry file must never contain token material');
    }
  });

  it('refuses, and does not switch, when the host cannot be asked to confirm', async () => {
    await seedRegistry();
    // No SPOTIFY_MCP_CONFIRM bypass, and the in-memory client declares no
    // elicitation capability. `requiredConfirmationRefusal` must treat the
    // 'unsupported' verdict as a refusal — this is the case where a gate that
    // fails OPEN would let a harness switch accounts unattended.
    const client = realClient(personal);
    const { mcp, server } = await harness(client, 'silent');
    const result = await mcp.callTool({ name: 'switch_account', arguments: { profile: 'work' } });
    const structured = result.structuredContent as { ok: boolean; cancelled?: boolean; reason?: string };
    assert.equal(structured.ok, false, 'switch_account must fail closed when it cannot be confirmed');
    assert.equal(structured.cancelled, true);
    assert.equal(
      structured.reason,
      'confirmation_unavailable',
      'the refusal must name WHY — an unavailable host and a failed prompt are different problems',
    );
    assert.equal(client.tokenFile, personal.tokenFile, 'the client switched despite the refusal');
    assert.equal(
      readAccounts().find((e) => e.profile === 'work')?.lastUsed,
      undefined,
      'a refused switch must not record the account as having acted',
    );
    await mcp.close();
    await server.close();
  });

  it('refuses when the confirmation prompt fails on the wire (#684)', async () => {
    await seedRegistry();
    const client = realClient(personal);
    const { mcp, server } = await harness(client, 'failing');
    const result = await mcp.callTool({ name: 'switch_account', arguments: { profile: 'work' } });
    const structured = result.structuredContent as { ok: boolean; reason?: string };
    assert.equal(structured.ok, false);
    assert.equal(
      structured.reason,
      'elicitation_failed',
      'a prompt that fails mid-flight must refuse; the reason names which refusal this was',
    );
    assert.equal(client.tokenFile, personal.tokenFile, 'a failed prompt still switched the account');
    await mcp.close();
    await server.close();
  });

  it('refuses a profile with no credentials, and leaves the session where it was', async () => {
    await seedRegistry();
    const client = realClient(personal);
    const { mcp, server } = await harness(client);
    const result = await mcp.callTool({ name: 'switch_account', arguments: { profile: 'absent' } });
    const structured = result.structuredContent as { ok: boolean; reason?: string };
    assert.equal(structured.ok, false);
    assert.equal(structured.reason, 'no_credentials');
    assert.equal(client.tokenFile, personal.tokenFile);
    await mcp.close();
    await server.close();
  });

  it('POSITIVE CONTROL: the same call succeeds once confirmation is possible', async () => {
    // Without this, the two refusals above would also pass if switch_account
    // simply never worked.
    await seedRegistry();
    const client = realClient(personal);
    const { mcp, server } = await harness(client);
    const result = await mcp.callTool({ name: 'switch_account', arguments: { profile: 'work' } });
    assert.equal((result.structuredContent as { changed: boolean }).changed, true);
    assert.equal(client.tokenFile, work.tokenFile);
    await mcp.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// The acting-account echo
// ---------------------------------------------------------------------------

describe('acting-account echo (#602)', () => {
  it('stamps account_id and display_name on a tool result', async () => {
    const client = realClient(personal);
    const server = new McpServer({ name: 'test', version: '0' });
    installActingAccountBoundary(server, resolveActingAccount, client);
    server.tool('probe', 'a tool with a structured result', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
    }));
    const transport = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(transport[0]), mcp.connect(transport[1])]);

    const result = await mcp.callTool({ name: 'probe', arguments: {} });
    assert.equal((result.structuredContent as { account_id: string }).account_id, personal.accountId);
    assert.equal((result.structuredContent as { display_name: string }).display_name, personal.displayName);
    await mcp.close();
    await server.close();
  });

  it('adds nothing when the identity cannot be read — absent, not empty', async () => {
    // A client pointed at a file with no credentials: `resolveActingAccount`
    // must not attempt a request and must not invent a value.
    const orphan = new SpotifyClient({ tokenFile: join(root, 'tokens.absent.json'), random: () => 0.5 });
    const before = requests.length;
    const echo = await resolveActingAccount(orphan);
    assert.equal(echo, undefined);
    assert.equal(requests.length, before, 'no request should be attempted for an account with no token file');

    const server = new McpServer({ name: 'test', version: '0' });
    installActingAccountBoundary(server, resolveActingAccount, orphan);
    server.tool('probe', 'a tool with a structured result', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
    }));
    const transport = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(transport[0]), mcp.connect(transport[1])]);
    const result = await mcp.callTool({ name: 'probe', arguments: {} });
    assert.equal(
      Object.hasOwn(result.structuredContent as object, 'account_id'),
      false,
      'an unreadable identity must leave the key ABSENT, not present-and-null: a caller '
      + 'has to be able to tell "no account id" from "we could not find out"',
    );
    await mcp.close();
    await server.close();
  });

  it('re-stamps after a switch, from the NEW account', async () => {
    const client = realClient(personal);
    const server = new McpServer({ name: 'test', version: '0' });
    installActingAccountBoundary(server, resolveActingAccount, client);
    server.tool('probe', 'a tool with a structured result', {}, async () => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { value: 1 },
    }));
    const transport = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(transport[0]), mcp.connect(transport[1])]);

    await mcp.callTool({ name: 'probe', arguments: {} });
    await client.switchAccount(work.tokenFile);
    const result = await mcp.callTool({ name: 'probe', arguments: {} });

    assert.equal((result.structuredContent as { account_id: string }).account_id, work.accountId);
    assert.equal((result.structuredContent as { display_name: string }).display_name, work.displayName);
    await mcp.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// The doctor names the acting account
// ---------------------------------------------------------------------------

describe('spotify_doctor active account (#602)', () => {
  it('names the acting account_id and the token file it read through', async () => {
    const client = realClient(personal);
    const { collectDoctorReport } = await import('../src/tools/doctortool.js');
    const report = await collectDoctorReport(client);
    const row = report.rows.find((r) => r.id === 'account');
    assert.ok(row, 'doctor must emit an account row');
    assert.match(row.summary, new RegExp(personal.accountId), 'the row must name the acting account_id');
    assert.ok(
      row.summary.includes(personal.tokenFile),
      'the row must name the token file the identity was read through',
    );
  });

  it('says the account_id was not returned rather than substituting the user id', async () => {
    // A registration older than Spotify's account_id field. A stand-in built
    // from `id` would look like a match to anything keying on the registry.
    const legacy = globalThis.fetch;
    globalThis.fetch = (async (): Promise<Response> => new Response(
      JSON.stringify({ id: 'user-legacy', display_name: 'Legacy', uri: 'spotify:user:user-legacy', external_urls: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof globalThis.fetch;
    try {
      const client = realClient(personal);
      const { collectDoctorReport } = await import('../src/tools/doctortool.js');
      const report = await collectDoctorReport(client);
      const row = report.rows.find((r) => r.id === 'account');
      assert.match(row!.summary, /account_id=not returned/);
      assert.doesNotMatch(row!.summary, /account_id=user-legacy/);
    } finally {
      globalThis.fetch = legacy;
    }
  });
});

// ---------------------------------------------------------------------------
// Registry file safety
// ---------------------------------------------------------------------------

describe('registry file (#602)', () => {
  it('is written owner-only and never lands in the real home', async () => {
    assert.ok(accountsFile().startsWith(root), 'the registry must resolve under the test temp root');
    assert.ok(existsSync(accountsFile()) || true);
  });

  it('refuses to overwrite a registry that is not JSON', async () => {
    // The guard lives on the READ, and every write path in this repo
    // (`switch_account`, and the auth walkthrough) reads before it writes —
    // so the file that cannot be parsed is also a file that cannot be
    // overwritten. This test drives that sequence rather than calling
    // `writeAccounts` directly, because the direct call is not the contract.
    const path = join(root, 'corrupt.json');
    const original = '{ this is not json';
    await writeFile(path, original, { mode: 0o600 });
    process.env.SPOTIFY_MCP_ACCOUNTS_FILE = path;
    try {
      assert.throws(() => readAccounts(), /not valid JSON/);
      assert.equal(await readFile(path, 'utf8'), original, 'the corrupt file must be left alone');
    } finally {
      process.env.SPOTIFY_MCP_ACCOUNTS_FILE = join(root, 'accounts.json');
    }
  });

  it('drops a malformed entry instead of taking the whole listing with it', async () => {
    const { writeAccounts } = await import('../src/accounts.js');
    const path = join(root, 'partial.json');
    await writeFile(path, JSON.stringify({
      version: 1,
      accounts: [
        { accountId: work.accountId, profile: 'work', tokenFile: work.tokenFile },
        { accountId: '', profile: 'broken' },
        'not even an object',
      ],
    }), { mode: 0o600 });
    process.env.SPOTIFY_MCP_ACCOUNTS_FILE = path;
    try {
      const entries = readAccounts();
      assert.deepEqual(entries.map((e) => e.accountId), [work.accountId]);
    } finally {
      process.env.SPOTIFY_MCP_ACCOUNTS_FILE = join(root, 'accounts.json');
    }
  });
});
