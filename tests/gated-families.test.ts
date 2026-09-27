/**
 * PR-time coverage of the app-registration-gated contract (#645, item 4).
 *
 * ## Why this file exists
 *
 * The gated families — `/markets`, `/artists/{id}/top-tracks`,
 * `/users/{id}`, `/users/{id}/playlists`, the `/me/{type}/contains` family and
 * the multi-id `?ids=` batch endpoints — had NO coverage that runs without a
 * live Spotify token. `scripts/tool-gate-check.mjs` and `scripts/live-e2e.mjs`
 * probe them against a real account, and neither is wired into PR CI, so a
 * regression in the 403 degradation shipped silently and a user with a current
 * app registration found it first.
 *
 * This file is that signal. It drives the REAL tool handlers against a client
 * whose every request 403s, in the style of `tests/exhaust2_enggating.test.ts`,
 * and asserts the degradation each family is DOCUMENTED to have. It needs no
 * token, no network, and no account.
 *
 * ## What "stubbing fetch" means here
 *
 * Two levels, deliberately, because they fail differently:
 *
 *   - the family-level tests stub the CLIENT (`client.get` throwing
 *     `SpotifyApiError(403)`). This is where the per-tool degradation lives —
 *     the message, the `cause`, the disclosed wording — and it is the level
 *     `tests/exhaust2_enggating.test.ts` works at.
 *   - the contract tests stub `globalThis.fetch` and drive a REAL
 *     `SpotifyClient`, so the wire path (403 body → `SpotifyApiError` →
 *     `gatedSurface` annotation) is exercised too. A 403 fabricated by the
 *     client mock proves the handler's branch; only a real 403 proves the
 *     client produces the error the branch is written against.
 *
 * ## The list this asserts is DERIVED, and that is the point
 *
 * The issue's own list of gated tools is stale and this file says so in a test
 * rather than in prose. `are_you_following_artist` and `get_categories` do not
 * exist in the server at all (`#638` deleted them with their endpoints;
 * following reads moved to `check_following_artists` on `/me/library/contains`,
 * which is NOT gated). A coverage file that hard-codes the stale names would
 * pass while testing nothing. So the expectations are read from
 * `GATED_FAMILIES`, and a test below asserts that the documented names really
 * are gone.
 */
import './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpotifyApiError } from '../src/client.js';
import { GATED_FAMILIES, isGatedPath } from '../src/gating.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerLibraryTools } from '../src/tools/library.js';
import { registerUsersTools } from '../src/tools/users.js';
import { registerFollowingTools } from '../src/tools/following.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (a: Record<string, unknown>) => Promise<ToolContent>;
};
type Call = { method: string; path: string; params?: Record<string, string> };

interface FakeClient {
  get: (path: string, params?: Record<string, string>) => Promise<unknown>;
  getAllPages: (path: string, params?: Record<string, string>) => Promise<unknown[]>;
  calls: Call[];
}

/** A client whose every GET is a 403, recording the paths it was asked for. */
function forbiddenClient(): FakeClient {
  const calls: Call[] = [];
  const self: FakeClient = {
    calls,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      throw new SpotifyApiError(403, 'Forbidden');
    },
    getAllPages: async function (this: FakeClient, path: string, params?: Record<string, string>) {
      return (await this.get(path, params)) as unknown[];
    },
  };
  return self;
}

function makeServer(registered: RegisteredTool[]): unknown {
  return {
    tool: (name: string, description: string, schema: Record<string, unknown>, handler: RegisteredTool['handler']) =>
      registered.push({ name, description, schema, handler }),
  };
}

function find(registered: RegisteredTool[], name: string): RegisteredTool {
  const t = registered.find((x) => x.name === name);
  assert.ok(t, `missing tool ${name}`);
  return t!;
}

/**
 * Register every module that owns a gated tool, against one 403 client.
 *
 * One registration pass for the whole file so the family tests can assert on
 * the union of what was called, and so a tool that moves modules is caught by
 * the registration assertion rather than by a "missing tool" throw in whichever
 * test happened to reach it first.
 *
 * `playlisthealth` is here because `get_playlist_followers` — a named tool of
 * the `user-profile` family — lives in it, not in `users`. That split is the
 * kind of thing a hand-kept import list gets wrong, which is why the coverage
 * assertion below checks the REGISTRATION rather than trusting this list.
 */
function registerGatedModules(): { registered: RegisteredTool[]; client: FakeClient } {
  const registered: RegisteredTool[] = [];
  const client = forbiddenClient();
  const server = makeServer(registered);
  registerCatalogTools(server as never, client as never);
  registerUsersTools(server as never, client as never);
  registerLibraryTools(server as never, client as never);
  registerFollowingTools(server as never, client as never);
  registerPlaylistHealthTools(server as never, client as never);
  return { registered, client };
}

const { registered: GATED_TOOLS, client: SHARED_CLIENT } = registerGatedModules();
const names = new Set(GATED_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// 1. The stale list in the issue, asserted as stale.
// ---------------------------------------------------------------------------

test('#645: the gated-tool list named in the issue is not the list the server has', () => {
  // Each of these was named as a gated tool to cover. None is a tool any more.
  // If one reappears, this test fails and says which family replaced it.
  for (const gone of ['are_you_following_artist', 'get_categories', 'get_category_playlists', 'check_saved_items']) {
    assert.ok(!names.has(gone), `${gone} is registered again — update this test and the #645 notes`);
  }

  // The replacement for `are_you_following_artist`, and the reason the
  // replacement is NOT in the gated set: following reads moved to
  // `GET /me/library/contains`, which answered 200 on the probe that 403'd the
  // `/me/following/contains` family.
  assert.ok(names.has('check_following_artists'), 'the following reader should be check_following_artists');
  assert.ok(
    !isGatedPath('/me/library/contains'),
    '/me/library/contains must stay out of the gated class: it is the documented migration target',
  );
});

test('#645: every gated family that claims a live call site ships the tools it names', () => {
  // The census cross-checks this column in CI, but the census runs against the
  // WHOLE registry. This is the narrow assertion the harness depends on: a
  // gated tool this file cannot register would make the family untested while
  // the family still looked covered.
  const NOT_REGISTERED_HERE = new Set([
    // Composite/analytics tools owned by modules this file does not register;
    // they reach a gated read through shared helpers, and each has its own
    // module-level coverage.
    'queue_playlist', 'artist_collab_network', 'artist_completeness_score',
    'batch_add_to_playlist', 'copy_playlist', 'move_items_between_playlists',
    'browse_category_deepdive', 'category_resolver', 'catalog_batch_lookup',
  ]);
  for (const family of GATED_FAMILIES) {
    for (const tool of family.tools) {
      if (NOT_REGISTERED_HERE.has(tool)) continue;
      assert.ok(names.has(tool), `family ${family.id} names ${tool}, which this file does not register — add its module`);
    }
  }
});

// ---------------------------------------------------------------------------
// 2. The per-tool 403 degradation, for every family with a live call site.
// ---------------------------------------------------------------------------

test('#645: get_available_markets discloses the removal instead of reporting a bare Forbidden', async () => {
  const tool = find(GATED_TOOLS, 'get_available_markets');
  await assert.rejects(
    tool.handler({ response_format: 'concise' }),
    (err: Error & { cause?: unknown }) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /\/markets was removed by Spotify.s February 2026/);
      // The honesty requirement: the tool must say what is NOT true either. A
      // message that only said "removed" would read as "no grandfathered
      // registration can read this", which no probe in this repo establishes.
      assert.match(err.message, /unverified/i);
      assert.ok(err.cause instanceof SpotifyApiError);
      assert.equal((err.cause as SpotifyApiError).status, 403);
      return true;
    },
  );
});

test('#645: get_artist_top_tracks attributes the 403 to the registration, not to a scope', async () => {
  const tool = find(GATED_TOOLS, 'get_artist_top_tracks');
  await assert.rejects(
    tool.handler({ id: '4YRxDV8wJFPHPTeXepOstw' }),
    (err: Error & { cause?: unknown }) => {
      assert.match(err.message, /403/);
      // The distinction the message exists to make: a scope problem and a
      // registration problem are fixed by different actions, and conflating
      // them sends an operator to add scopes that cannot help. The wording
      // offers BOTH because this tool cannot tell them apart from the status
      // alone — what makes it safe to name only one is that naming neither as
      // certain is the honest reading of a bare 403.
      assert.match(err.message, /may not be available for this app registration, or the required scope is missing/);
      assert.ok(err.cause instanceof SpotifyApiError);
      assert.equal((err.cause as SpotifyApiError).status, 403);
      return true;
    },
  );
});

test('#645: get_user_profile discloses the removal and says there is no replacement', async () => {
  const tool = find(GATED_TOOLS, 'get_user_profile');
  await assert.rejects(
    tool.handler({ user_id: 'j.lee12' }),
    (err: Error & { cause?: unknown }) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /GET \/users\/\{id\} was removed/);
      // `/me` only ever serves the caller, so an arbitrary user_id has nothing
      // to migrate onto. Saying so is what stops a reader hunting for a
      // replacement endpoint.
      assert.match(err.message, /no endpoint replaced it/);
      assert.ok(err.cause instanceof SpotifyApiError);
      return true;
    },
  );
});

test('#645: get_user_playlists_by_id discloses the removal on the playlists read', async () => {
  const tool = find(GATED_TOOLS, 'get_user_playlists_by_id');
  await assert.rejects(
    tool.handler({ user_id: 'j.lee12' }),
    (err: Error & { cause?: unknown }) => {
      assert.match(err.message, /403/);
      assert.match(err.message, /GET \/users\/\{id\}\/playlists was removed/);
      assert.ok(err.cause instanceof SpotifyApiError);
      return true;
    },
  );
});

test('#645: get_playlist_followers DISCLOSES the gated owner-profile read instead of swallowing it', async () => {
  // This tool is the one gated family whose gated leg is OPTIONAL. Its
  // `/playlists/{id}` read is not gated and must keep working; only
  // `include_profiles: true` reaches the removed `/users/{id}`. So the client
  // 403s on the user path alone — a blanket 403 would fail the playlist read
  // first and prove nothing about the disclosure.
  const client: FakeClient = {
    calls: [],
    get: async (path, params) => {
      client.calls.push({ method: 'GET', path, params });
      if (path.startsWith('/users/')) throw new SpotifyApiError(403, 'Forbidden');
      return {
        id: '2lM1KCgZazYQ7e6b6j1KJd',
        name: 'Test playlist',
        followers: { total: 12 },
        owner: { id: 'j.lee12', display_name: 'J' },
      };
    },
    getAllPages: async () => [],
  };
  const registered: RegisteredTool[] = [];
  registerPlaylistHealthTools(makeServer(registered) as never, client as never);
  const tool = find(registered, 'get_playlist_followers');

  const r = await tool.handler({ playlist_id: '2lM1KCgZazYQ7e6b6j1KJd', include_profiles: true });
  const structured = r.structuredContent ?? {};

  // The count came from the ungated read and is reported.
  assert.equal(structured.followers_total, 12);
  // The requested-but-unreadable profile is STATED, in the payload and the
  // prose. Before #638 this was `catch { ownerProfile = null }`, which returned
  // a result identical to one that had declined to fetch it — an omitted field
  // presented as "no profile", for a profile the caller explicitly asked for.
  //
  // The disclosure carries Spotify's own word ("Forbidden"), not the status
  // code, so this asserts the CAUSE is named rather than matching a number the
  // server does not print here.
  assert.match(String(structured.owner_profile_error), /Forbidden/);
  assert.match(String(structured.owner_profile_error), /removed by Spotify's February 2026/);
  assert.match(String(structured.owner_profile_error), /follower count above is read from GET \/playlists\/\{id\}/);
  assert.match(r.content.map((c) => c.text).join('\n'), /Owner profile unavailable/);
  assert.equal(structured.owner_profile, undefined, 'an unread profile must not be reported as read');
});

test('#645: a 403 on the ungated playlist read still fails loudly', async () => {
  // The other direction, and the reason the test above needed a selective
  // client: `/playlists/{id}` is NOT gated, so a 403 there is a real failure
  // and must not be absorbed into the "profile unavailable" disclosure.
  const client = forbiddenClient();
  const registered: RegisteredTool[] = [];
  registerPlaylistHealthTools(makeServer(registered) as never, client as never);
  const tool = find(registered, 'get_playlist_followers');
  await assert.rejects(
    tool.handler({ playlist_id: '2lM1KCgZazYQ7e6b6j1KJd' }),
    (err: unknown) => err instanceof SpotifyApiError && err.status === 403,
  );
});

test('#645: the batch family fails loudly on a 403 instead of degrading to per-id reads', async () => {
  // `fallback: 'replaced'` for batch-several is a claim about the CLIENT
  // (fetchSeveral falls back to per-item GETs), not about this handler. The
  // per-id reads are NOT gated, so a 403 on the batch path must not be
  // swallowed into an empty list.
  const client = forbiddenClient();
  const registered: RegisteredTool[] = [];
  registerCatalogTools(makeServer(registered) as never, client as never);
  const tool = find(registered, 'get_several_tracks');
  await assert.rejects(
    tool.handler({ ids: ['4uLU6hMCjMI75M1A2tKUQC'] }),
    (err: unknown) => err instanceof SpotifyApiError && err.status === 403,
  );
});

test('#645: a non-403 on a gated path is not laundered into the gated message', async () => {
  // A 500 on `/markets` is a server fault, not a registration fact. Reporting
  // it as the gated message would tell an operator their app registration is
  // the problem when Spotify's is.
  const calls: Call[] = [];
  const client: FakeClient = {
    calls,
    get: async (path, params) => {
      calls.push({ method: 'GET', path, params });
      throw new SpotifyApiError(500, 'Internal Server Error');
    },
    getAllPages: async () => { throw new Error('unused'); },
  };
  const registered: RegisteredTool[] = [];
  registerCatalogTools(makeServer(registered) as never, client as never);
  const tool = find(registered, 'get_available_markets');
  await assert.rejects(
    tool.handler({ response_format: 'concise' }),
    (err: unknown) => {
      assert.ok(!(/was removed by Spotify/.test(String((err as Error).message))), 'a 500 must not be reported as a removal');
      // The 403 branch wraps in a new Error with `cause`; every other status is
      // rethrown UNCHANGED, so the classification the caller branches on is
      // still on the error rather than buried in a string.
      assert.ok(err instanceof SpotifyApiError, 'a non-403 must reach the caller as the original error');
      assert.equal((err as SpotifyApiError).status, 500);
      assert.equal((err as SpotifyApiError).message, 'Internal Server Error');
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 3. The wire path: a real SpotifyClient turning a real 403 body into the
//    error every branch above is written against.
// ---------------------------------------------------------------------------

test('#645: a real 403 response becomes an annotated SpotifyApiError end to end', async () => {
  // Stubbing `client.get` proves the handler's branch. It cannot prove the
  // client PRODUCES the error that branch tests for, so this drives a real
  // SpotifyClient over a stubbed fetch — the last hop the family-level tests
  // replace.
  const realFetch = globalThis.fetch;
  const home = await mkdtemp(join(tmpdir(), 'gated-families-home-'));
  const tokenFile = join(home, 'tokens.json');
  await writeFile(
    tokenFile,
    JSON.stringify({ access_token: 'probe', refresh_token: 'probe', expires_at: Date.now() + 3_600_000 }),
  );
  const previous = { token: process.env.SPOTIFY_MCP_TOKEN_FILE, clientId: process.env.SPOTIFY_CLIENT_ID };
  process.env.SPOTIFY_MCP_TOKEN_FILE = tokenFile;
  process.env.SPOTIFY_CLIENT_ID = 'gated-families-probe';

  const seen: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    seen.push(String(url));
    return new Response(JSON.stringify({ error: { status: 403, message: 'Forbidden' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const { SpotifyClient } = await import('../src/client.js');
    const { installGatedPathContract } = await import('../src/gating.js');
    const client = new SpotifyClient();
    installGatedPathContract(client);

    await assert.rejects(client.get('/markets'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError, 'a 403 must surface as a SpotifyApiError');
      assert.equal((err as SpotifyApiError).status, 403);
      // The annotation is what lets a tool branch on the gated class without
      // matching on message text — and it is the only thing #765 added when
      // it stopped replacing the error type.
      assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, true);
      assert.equal((err as unknown as { gatedPath?: string }).gatedPath, '/markets');
      return true;
    });

    // A gated path and a normal one must not be conflated: the same 403 body on
    // `/me/player/play` is a Premium/scope fact, not a registration fact.
    await assert.rejects(client.get('/me/player/play'), (err: unknown) => {
      assert.ok(err instanceof SpotifyApiError);
      assert.equal((err as unknown as { gatedSurface?: boolean }).gatedSurface, undefined);
      return true;
    });

    assert.ok(seen.some((u) => u.includes('/markets')), 'the stubbed fetch should have seen the markets read');
  } finally {
    globalThis.fetch = realFetch;
    if (previous.token === undefined) delete process.env.SPOTIFY_MCP_TOKEN_FILE;
    else process.env.SPOTIFY_MCP_TOKEN_FILE = previous.token;
    if (previous.clientId === undefined) delete process.env.SPOTIFY_CLIENT_ID;
    else process.env.SPOTIFY_CLIENT_ID = previous.clientId;
    await rm(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. The harness verdicts, against the shapes this file's 403s actually take.
// ---------------------------------------------------------------------------

test('#645: the harness scores a gated 403 as GATED — a satisfied row, not a pass and not a failure', async () => {
  const { classifyToolResult, summarizeRun } = await import('../scripts/lib/gate-decision.mjs');

  // The shape the wire really produces for a gated family: a resolved result
  // carrying isError. A harness that only catches rejections scores this as a
  // PASS, which is how an expired token once read as a clean sweep.
  const gated = classifyToolResult({
    result: {
      isError: true,
      content: [{ type: 'text', text: 'Spotify returned 403 for /markets. GET /markets was removed by Spotify.' }],
      structuredContent: { error: { kind: 'forbidden', reason: 'registration_gated', status: 403 } },
    },
    name: 'get_available_markets',
  });
  assert.equal(gated.status, 'GATED', 'a documented 403 degradation is not a functional failure');

  const summary = summarizeRun([gated]);
  assert.equal(summary.functional, 0, 'a gated row is not a data answer, so it is not in the ratio');
  assert.equal(summary.tested, 1, 'but the tool DID answer, so the row was tested');
  assert.equal(summary.passed, 0, 'and it is not counted as a pass either');
  // A current app registration is supposed to gate every one of these tools.
  // If an all-gated run could not exit 0, this gate would be red on correct
  // behaviour forever — which is the condition that made the original
  // unconditional `exit(0)` look reasonable.
  assert.equal(summary.exitCode, 0, 'an all-gated run is a correct run and must be able to exit 0');
  assert.match(summary.ratio, /n\/a \(every tested tool returned its gated disclosure\)/);
});

test('#645: a run that tested NOTHING still exits 1 — "no verdict" is not a pass', async () => {
  const { summarizeRun } = await import('../scripts/lib/gate-decision.mjs');

  // The one hole the GATED rule must not open: if an all-gated run passes
  // because a gated verdict is a real verdict, then a run that obtained NO
  // verdict at all must not pass for the same reason. This is the regression
  // the unconditional `exit(0)` shipped.
  assert.equal(summarizeRun([]).exitCode, 1, 'an empty run is not a pass');
  assert.equal(summarizeRun([]).tested, 0);

  const allAuth = summarizeRun(
    Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, status: 'AUTH', detail: '401' })),
  );
  assert.equal(allAuth.tested, 0, 'AUTH is the one status that means the question was never asked');
  assert.equal(allAuth.exitCode, 1, 'so an all-auth run is not a pass');
  assert.equal(allAuth.functional, 0);
  assert.match(allAuth.ratio, /n\/a \(no tool was exercised\)/);
  assert.match(allAuth.authNote, /npm run auth/);
});

test('#645: a 200 whose prose discloses a gated surface is GATED, not a clean pass', async () => {
  const { classifyToolResult } = await import('../scripts/lib/gate-decision.mjs');
  // `fallback: 'explained'` families answer 200 and disclose in the text, so an
  // `isError`-only check scores the designed behaviour as a clean pass — and
  // the broken version of the same behaviour as one too.
  const row = classifyToolResult({
    result: { content: [{ type: 'text', text: 'Top tracks unavailable: Spotify returned 403 for /artists/x/top-tracks.' }] },
    name: 'get_artist_top_tracks',
  });
  assert.equal(row.status, 'GATED');
});

/**
 * The candidate list `tool-gate-check.mjs` probes is DERIVED, not hand-kept.
 * That derivation is item 1's central claim, so it is asserted here rather than
 * trusted: a harness that quietly reverted to a hand-written list would
 * otherwise go on probing two deleted tool names forever and nobody would know.
 */
test('#645: the derived candidate list is the gated families, not the issue’s stale list', async () => {
  const { deriveGatedToolNames } = await import('../scripts/lib/gate-decision.mjs');

  const derived = deriveGatedToolNames(GATED_FAMILIES);

  assert.ok(derived.length > 0, 'the real gated table produced no candidates at all');
  assert.deepEqual(derived, [...derived].sort(), 'the list is sorted, so a diff of two runs is readable');
  assert.equal(new Set(derived).size, derived.length, 'a tool in two families appears once');

  // Every name the union produced must be a real family tool — a derivation that
  // invented or dropped a name would be worse than the list it replaced.
  const fromTable = new Set(GATED_FAMILIES.flatMap((f) => f.tools));
  for (const name of derived) {
    assert.ok(fromTable.has(name), `${name} is in the derived list but in no family's tools column`);
  }

  // The names the ISSUE listed, checked against the derivation itself. Two of
  // them name tools the server does not have, and `check_in_library` /
  // `check_following_artists` read the NON-gated `/me/library/contains`. If the
  // derivation ever stops agreeing with this, the disagreement is the finding.
  for (const gone of ['are_you_following_artist', 'get_categories', 'get_category_playlists', 'check_saved_items']) {
    assert.ok(!derived.includes(gone), `${gone} does not exist in the server and must not be probed`);
  }
  for (const notGated of ['check_in_library', 'check_following_artists']) {
    assert.ok(!derived.includes(notGated), `${notGated} reads the non-gated /me/library/contains`);
  }
  // …and the two that ARE genuinely gated, so the test cannot pass by deriving
  // an empty or irrelevant list.
  for (const real of ['get_artist_top_tracks', 'get_available_markets']) {
    assert.ok(derived.includes(real), `${real} is gated and must be in the derived list`);
  }
});

test('#645: a family with no live call site contributes no candidates', async () => {
  const { deriveGatedToolNames } = await import('../scripts/lib/gate-decision.mjs');
  // A retained CLASSIFIER for a path nothing reads any more still has a row in
  // GATED_FAMILIES. Probing its (now absent) tools would report deletions as
  // functional failures.
  const names = deriveGatedToolNames([
    { id: 'live', tools: ['get_available_markets'] },
    { id: 'retired-classifier', tools: [] },
    { id: 'overlaps', tools: ['get_available_markets', 'market_validate'] },
  ]);
  assert.deepEqual(names, ['get_available_markets', 'market_validate']);
  assert.deepEqual(deriveGatedToolNames([]), [], 'no families is an empty list, not a throw');
});

test('#645: a missing build is a loud failure, not a silently empty candidate list', async () => {
  const { loadGatedFamilies } = await import('../scripts/lib/gated-families.mjs');
  // The failure mode this guards is the one #645 is about, one level down: if
  // the build were absent and the loader returned `[]`, the harness would
  // derive ZERO candidates, probe nothing, and — under a summary that only
  // fails on a FAILURE row — report a clean run. Throwing is the only answer
  // that cannot be mistaken for health.
  const empty = await mkdtemp(join(tmpdir(), 'gated-families-'));
  try {
    await assert.rejects(
      () => loadGatedFamilies({ distRoot: empty }),
      /no built gated-family table/,
      'an absent build must throw rather than yield an empty list',
    );
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('#645: the loader reads the real built table, so the harness reasons about the build it will spawn', async () => {
  const { loadGatedFamilies } = await import('../scripts/lib/gated-families.mjs');
  const families = await loadGatedFamilies();
  assert.ok(Array.isArray(families) && families.length > 0, 'the real built GATED_FAMILIES is empty');
  assert.deepEqual(
    families.map((f) => f.id),
    GATED_FAMILIES.map((f) => f.id),
    'the loader and the source table disagree — dist is stale, run npm run build',
  );
});
