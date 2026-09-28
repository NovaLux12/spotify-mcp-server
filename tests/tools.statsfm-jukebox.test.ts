/**
 * `statsfm_jukebox` (#726).
 *
 * The tests read `client.calls` and `payload`, not the prose. Every assertion
 * that matters is about a WRITE (did any happen, in what order, with which
 * positions) or about a VALUE THAT COULD NOT BE READ (is it counted, or was it
 * quietly turned into a plausible number) — and both are visible in the record,
 * while neither is guaranteed by a sentence in the response text.
 *
 * The stub client FAILS THE TEST on any POST/PUT/DELETE unless a case has
 * explicitly opted in. That is the mechanism behind the "dry run performs zero
 * writes" criterion: a dry run that accidentally issued a write would not
 * return a plausible-looking result, it would throw, and the assertion about the
 * proposal list would never be reached.
 */
import './helpers/hermetic.js';
import { DEFAULT_TOKEN_FILE } from './helpers/hermetic.js';

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerStatsfmJukeboxTools } from '../src/tools/statsfm_jukebox.js';
import {
  __setTasteCompositeFetchImpl,
  __resetTasteCompositeFetchImpl,
} from '../src/tools/taste_composites.js';

// ---------------------------------------------------------------- fixtures

/** A 22-char base62 id, the only shape `spotify:track:` can be built from. */
const ID = (n: number): string => String(n).padStart(22, '0');
/** A 22-char base62 playlist id — the only shape a bare Spotify id can take. */
const PL = 'P'.repeat(22);

type WireCall = {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  params?: Record<string, string>;
  body?: unknown;
};

type StubClient = {
  calls: WireCall[];
  /** Playlist rows the `/playlists/{id}` and `/playlists/{id}/items` reads serve. */
  rows: Array<{ uri: string; name: string }>;
  /** The `name` the playlist object carries. */
  playlistName: string;
  /** The playlist object's own count. Falls back to the legacy spelling when set. */
  total: number;
  /** Serve the pre-Feb-2026 `tracks.total` spelling instead of `items.total`. */
  legacyTotalField: boolean;
  /** When true, `/playlists/{id}/items` reports no `total` at all. */
  hideTotal: boolean;
  /** When set, the playlist read throws this. */
  playlistReadFails: Error | null;
  /** When true, allow writes; otherwise any write method throws. */
  allowWrites: boolean;
};

function makeStub(): StubClient {
  return {
    calls: [],
    rows: [],
    playlistName: 'Jukebox',
    total: 0,
    legacyTotalField: false,
    hideTotal: false,
    playlistReadFails: null,
    allowWrites: false,
  };
}

function makeClient(stub: StubClient): SpotifyClient {
  const guard = (method: WireCall['method'], path: string) => {
    if (method !== 'get' && !stub.allowWrites) {
      throw new Error(
        `stub client refused a ${method.toUpperCase()} to ${path}: this case asserted on a write it did not expect`,
      );
    }
  };
  const client = {
    // #1385: the account-keyed stores refuse an empty token file, so the stub
    // names the hermetic default account the same way the real client does.
    // Only the basename reaches the key derivation and receipts are not
    // persistent here, so this path is never read or written.
    tokenFile: DEFAULT_TOKEN_FILE,
    async get(path: string, params?: Record<string, string>): Promise<unknown> {
      stub.calls.push({ method: 'get', path, params });
      if (stub.playlistReadFails && path.startsWith('/playlists/') && !path.endsWith('/items')) {
        throw stub.playlistReadFails;
      }
      if (path === `/playlists/${PL}`) {
        const countField = stub.legacyTotalField ? { tracks: { total: stub.total } } : { items: { total: stub.total } };
        return { id: PL, name: stub.playlistName, ...countField };
      }
      if (path.endsWith('/items')) {
        const offset = Number(params?.offset ?? '0');
        const limit = Number(params?.limit ?? '100');
        const page = stub.rows.slice(offset, offset + limit);
        return {
          // `hideTotal` models a malformed / truncated page that reports no
          // `total` at all — the case where a receipt's `after` must be absent
          // rather than inferred from what the caller intended to write.
          ...(stub.hideTotal ? {} : { total: stub.total }),
          // `next` present only while more rows remain, so the walk terminates.
          ...(offset + limit < stub.rows.length ? { next: 'more' } : {}),
          items: page.map((r) => ({ item: r.uri === '' ? { name: r.name } : { uri: r.uri, name: r.name } })),
        };
      }
      return null;
    },
    async getAllPagesWithTruncation<T>(path: string, params?: Record<string, string>) {
      const items: T[] = [];
      let offset = 0;
      let pages = 0;
      for (;;) {
        const res = (await client.get(path, { ...params, offset: String(offset) })) as {
          items?: T[];
          next?: string;
          total?: number;
        } | null;
        if (!res?.items) break;
        items.push(...res.items);
        pages += 1;
        offset += res.items.length;
        if (!res.next || res.items.length === 0 || pages > 50) break;
      }
      return { items, truncated: false, truncatedByCap: false, reportedTotal: null, pages };
    },
    async getAllPages<T>(path: string, params?: Record<string, string>): Promise<T[]> {
      return (await client.getAllPagesWithTruncation<T>(path, params)).items;
    },
    async post(path: string, body?: unknown) {
      guard('post', path);
      stub.calls.push({ method: 'post', path, body });
      return { snapshot_id: 'snap-post' };
    },
    async put(path: string, body?: unknown) {
      guard('put', path);
      stub.calls.push({ method: 'put', path, body });
      return { snapshot_id: 'snap-put' };
    },
    async delete(path: string, body?: unknown) {
      guard('delete', path);
      stub.calls.push({ method: 'delete', path, body });
      return { snapshot_id: 'snap-del' };
    },
  };
  return client as unknown as SpotifyClient;
}

function streamRow(trackId: string | null, trackName: string, artist: string, playedAt: unknown) {
  return {
    track: { ...(trackId === null ? {} : { id: trackId }), name: trackName, artists: [{ id: `a-${artist}`, name: artist }] },
    ...(playedAt === undefined ? {} : { playedAt }),
  };
}

/** Days-ago ISO stamp, so the fixture does not depend on the wall clock. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function installFixtures(rows: unknown[]) {
  __setTasteCompositeFetchImpl(async (url: string) => {
    if (url.includes('/streams')) return { items: rows };
    throw new Error(`unexpected stats.fm path: ${url}`);
  });
}

type ToolContent = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type RegisteredTool = {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<ToolContent>;
};

type ElicitMode = 'confirm' | 'decline' | 'unsupported' | 'error';

/**
 * A server double that owns the elicitation surface `confirm.ts` probes.
 *
 * `unsupported` is the default on purpose: a test that forgets to arrange a
 * confirmation gets the FAIL-CLOSED path, which is what production does when a
 * client cannot prompt. A commit test has to opt in deliberately.
 */
function makeHarness(stub: StubClient, elicit: ElicitMode = 'unsupported') {
  const registered: RegisteredTool[] = [];
  const prompts: string[] = [];
  const inner = {
    getClientCapabilities: () => (elicit === 'unsupported' ? {} : { elicitation: {} }),
    elicitInput: async (request: { message: string }) => {
      prompts.push(request.message);
      if (elicit === 'error') throw new Error('wire failed');
      if (elicit === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    },
  };
  const server = {
    server: inner,
    tool: (
      name: string,
      description: string,
      schema: RegisteredTool['schema'],
      annotationsOrHandler: unknown,
      maybeHandler?: unknown,
    ) => {
      const handler = (typeof maybeHandler === 'function' ? maybeHandler : annotationsOrHandler) as RegisteredTool['handler'];
      registered.push({ name, description, schema, handler });
    },
  };
  registerStatsfmJukeboxTools(server as unknown as McpServer, makeClient(stub));
  const tool = registered.find((t) => t.name === 'statsfm_jukebox');
  assert.ok(tool, 'statsfm_jukebox must be registered');
  return {
    tool,
    prompts,
    invoke: async (args: Record<string, unknown> = {}) => {
      // Parse through the real schema so defaults are the ones a host gets.
      // `statsfm_user` is supplied explicitly rather than through
      // STATSFM_USER_ID, so the fixture user is stated by the test that uses it.
      const parsed = z.object(tool.schema).parse({ statsfm_user: 'martijn', ...args });
      return tool.handler(parsed);
    },
  };
}

const writes = (stub: StubClient) => stub.calls.filter((c) => c.method !== 'get');
const payloadOf = (out: ToolContent) => (out.structuredContent ?? {}) as Record<string, unknown>;
const textOf = (out: ToolContent) => out.content.map((c) => c.text).join('\n');

const READONLY_ENV = 'SPOTIFY_MCP_READONLY';
const CONFIRM_ENV = 'SPOTIFY_MCP_CONFIRM';
const prior = { readonly: process.env[READONLY_ENV], confirm: process.env[CONFIRM_ENV] };

test.beforeEach(() => {
  delete process.env[READONLY_ENV];
  delete process.env[CONFIRM_ENV];
});

test.afterEach(() => {
  __resetTasteCompositeFetchImpl();
  if (prior.readonly === undefined) delete process.env[READONLY_ENV];
  else process.env[READONLY_ENV] = prior.readonly;
  if (prior.confirm === undefined) delete process.env[CONFIRM_ENV];
  else process.env[CONFIRM_ENV] = prior.confirm;
});

// ------------------------------------------------------------------ reads

/** A playlist whose rows are all outside the window, and a rotation to swap in. */
function staleScenario() {
  const stub = makeStub();
  stub.playlistName = 'Road Trip';
  stub.rows = [
    { uri: `spotify:track:${ID(1)}`, name: 'Old One' },
    { uri: `spotify:track:${ID(2)}`, name: 'Old Two' },
    { uri: `spotify:track:${ID(3)}`, name: 'Current' },
    { uri: `spotify:track:${ID(4)}`, name: 'Old Three' },
  ];
  stub.total = 4;
  installFixtures([
    streamRow(ID(3), 'Current', 'Fresh Face', daysAgo(1)),
    streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(2)),
    streamRow(ID(11), 'New B', 'Fresh Face', daysAgo(3)),
    streamRow(ID(12), 'New C', 'Second Act', daysAgo(4)),
  ]);
  return stub;
}

// ------------------------------------------------------------- dry run

test('a dry run proposes exactly replacements + appends and writes nothing', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);

  const out = await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: true });
  const body = payloadOf(out);

  assert.equal(body.ok, true);
  assert.equal(body.dry_run, true);
  const proposed = body.proposed as { replacements: unknown[]; appends: unknown[] };
  assert.equal(proposed.replacements.length, 2, 'two stale rows proposed');
  assert.equal(proposed.appends.length, 2, 'two new tracks proposed');
  for (const item of [...proposed.replacements, ...proposed.appends]) {
    assert.equal(typeof (item as { rationale: unknown }).rationale, 'string');
    assert.ok((item as { rationale: string }).rationale.length > 0, 'every proposal carries its reasoning');
  }
  // The stub throws on ANY write, so reaching this line at all is the assertion.
  assert.deepEqual(writes(stub), [], 'a dry run issues no write request');
  assert.equal(h.prompts.length, 0, 'a dry run does not ask for confirmation either');
});

test('dry_run defaults to TRUE — an omitted flag is a plan', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, replacements: 1, appends: 1 });
  const body = payloadOf(out);
  assert.equal(body.dry_run, true);
  assert.match(textOf(out), /DRY RUN/);
  assert.deepEqual(writes(stub), []);
});

test('a stale row is ranked, and the current row is never proposed for removal', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 3, appends: 0, dry_run: true }));
  const proposed = body.proposed as { replacements: Array<{ uri: string; rationale: string }> };
  const uris = proposed.replacements.map((r) => r.uri);
  assert.equal(uris.length, 3);
  assert.ok(
    !uris.includes(`spotify:track:${ID(3)}`),
    'the row played inside the window is not stale, whatever else is true about it',
  );
  for (const r of proposed.replacements) assert.match(r.rationale, /absent from the stream page|outside the/);
});

test('a replacement and an append never name the same track', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: true }));
  const proposed = body.proposed as { replacements: Array<{ uri: string }>; appends: Array<{ uri: string }> };
  const overlap = proposed.replacements
    .map((r) => r.uri)
    .filter((u) => proposed.appends.some((a) => a.uri === u));
  assert.deepEqual(overlap, [], 'a track proposed for removal is not also proposed for addition');
});

test('a candidate already in the playlist is not proposed as an append', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 0, appends: 5, dry_run: true }));
  const proposed = body.proposed as { appends: Array<{ uri: string }> };
  const uris = proposed.appends.map((a) => a.uri);
  for (const row of stub.rows) assert.ok(!uris.includes(row.uri), `${row.uri} is already in the playlist`);
});

test('a short list names the shortfall instead of being padded', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, replacements: 0, appends: 20, dry_run: true });
  const body = payloadOf(out);
  const proposed = body.proposed as { appends: unknown[] };
  // The fixture yields three candidates, not twenty.
  assert.equal(proposed.appends.length, 3);
  assert.match(textOf(out), /Short of what was asked for: 17 append/);
  assert.equal((body.available as { rotation_candidates: number }).rotation_candidates, 3);
});

// --------------------------------------- values that could not be read

test('a stream row with no readable play time is excluded and counted, not filed as stale', async () => {
  const stub = staleScenario();
  installFixtures([
    streamRow(ID(3), 'Current', 'Fresh Face', daysAgo(1)),
    // No play time at all: it cannot be placed in or out of the window, so it
    // is evidence for neither "recently played" nor "stale".
    streamRow(ID(3), 'Current', 'Fresh Face', undefined),
    streamRow(ID(20), 'Timeless', 'Ancient', undefined),
    streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(2)),
  ]);
  const h = makeHarness(stub);
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 5, appends: 5, dry_run: true }));
  const streams = body.streams as { unreadable_timestamps: number; in_window: number; returned: number };
  assert.equal(streams.unreadable_timestamps, 2, 'both untimed rows are counted');
  assert.equal(streams.in_window, 2, 'and neither is counted as in-window');
  assert.equal(streams.returned, 4, 'the total the page returned is still reported');

  const proposed = body.proposed as { replacements: Array<{ uri: string }>; appends: Array<{ uri: string }> };
  const touched = [...proposed.replacements, ...proposed.appends].map((p) => p.uri);
  assert.ok(
    !touched.includes(`spotify:track:${ID(20)}`),
    'a track whose only stream row is unreadable must not be proposed for addition',
  );
  assert.match(textOf(await h.invoke({ playlist_id: PL, replacements: 0, appends: 5, dry_run: true })), /no readable play time/);
});

test('a stream row with no usable track id is counted and never rendered as a URI', async () => {
  const stub = staleScenario();
  installFixtures([
    streamRow(ID(3), 'Current', 'Fresh Face', daysAgo(1)),
    // A name, not an id. normalizeStreams would borrow this into the id field;
    // this module's output IS a URI, so it must be counted instead.
    streamRow(null, 'Mystery Single', 'Fresh Face', daysAgo(2)),
    streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(3)),
  ]);
  const h = makeHarness(stub);
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 0, appends: 5, dry_run: true }));
  const streams = body.streams as { unresolved_track_ids: number; in_window: number };
  assert.equal(streams.unresolved_track_ids, 1, 'the id-less row is counted');
  const proposed = body.proposed as { appends: Array<{ uri: string }> };
  for (const a of proposed.appends) {
    assert.match(a.uri, /^spotify:track:[0-9A-Za-z]{22}$/, `${a.uri} is a real track URI, not a borrowed name`);
  }
  assert.ok(!proposed.appends.some((a) => a.uri.includes('Mystery')));
  // It still counts toward the rotation — a listen is a listen.
  const rotation = body.rotation as Array<{ artist: string; streams: number }>;
  assert.equal(rotation.find((r) => r.artist === 'Fresh Face')?.streams, 3);
});

test('a playlist row with no readable URI is counted and left alone', async () => {
  const stub = makeStub();
  stub.rows = [
    { uri: '', name: 'Nameless Row' },
    { uri: `spotify:track:${ID(1)}`, name: 'Old One' },
  ];
  stub.total = 2;
  installFixtures([streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(1))]);
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, replacements: 5, appends: 0, dry_run: true });
  const body = payloadOf(out);
  assert.equal(body.playlist_rows_unreadable, 1);
  const proposed = body.proposed as { replacements: unknown[] };
  assert.equal(proposed.replacements.length, 1, 'only the addressable row is a removal candidate');
  assert.match(textOf(out), /no readable URI/);
});

test('a bounded page is disclosed, so "absent from the window" is not read as "never played"', async () => {
  const stub = makeStub();
  stub.rows = [{ uri: `spotify:track:${ID(1)}`, name: 'Ancient' }];
  stub.total = 1;
  // Every row the page carries is NEWER than the 90-day window start, so the
  // page provably cannot see back to it.
  installFixtures([streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(1))]);
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, replacements: 1, appends: 0, window_days: 90, dry_run: true });
  const streams = payloadOf(out).streams as {
    page_may_not_cover_window: boolean;
    page_oldest: string;
    page_newest: string;
  };
  assert.equal(streams.page_may_not_cover_window, true);
  assert.equal(streams.page_oldest, streams.page_newest, 'a one-row page spans a single instant');
  assert.match(textOf(out), /does not reach back to the window start/);
});

test('a page that does cover the window says so, rather than claiming staleness it cannot support', async () => {
  const stub = makeStub();
  // The playlist holds the track the page last saw 300 days ago, so the plan
  // can date its staleness from a real play rather than defaulting to unknown.
  stub.rows = [{ uri: `spotify:track:${ID(99)}`, name: 'Ancient' }];
  stub.total = 1;
  // One row inside the window, one genuinely old — the page reaches the start.
  installFixtures([
    streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(1)),
    streamRow(ID(99), 'Ancient', 'Old Band', daysAgo(300)),
  ]);
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, replacements: 1, appends: 0, window_days: 90, dry_run: true });
  const body = payloadOf(out);
  assert.equal((body.streams as { page_may_not_cover_window: boolean }).page_may_not_cover_window, false);
  const proposed = body.proposed as { replacements: Array<{ last_played_at: string | null; rationale: string }> };
  assert.equal(proposed.replacements.length, 1);
  // The page carried a real older play for this row, so the date is known —
  // not defaulted to null, and not to today.
  assert.equal(proposed.replacements[0]?.last_played_at, daysAgo(300).slice(0, 10));
});

test('a failed playlist read is reported as a failed read, not as an empty playlist', async () => {
  const stub = makeStub();
  stub.playlistReadFails = new Error('spotify said no');
  installFixtures([streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(1))]);
  const h = makeHarness(stub);
  const out = await h.invoke({ playlist_id: PL, dry_run: true });
  const body = payloadOf(out);
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'plan_unavailable');
  assert.equal(body.read_failure, 'Error');
  assert.equal(body.proposed, undefined, 'no plan is presented as though it were computed');
  assert.match(textOf(out), /Nothing was read and nothing was written/);
});

test('the playlist total is read from items.total, not the pre-2026 tracks.total spelling', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub);
  const modern = payloadOf(await h.invoke({ playlist_id: PL, replacements: 0, appends: 0, dry_run: true }));
  assert.equal(modern.playlist_total, 4, 'items.total is the canonical spelling and is read');

  stub.legacyTotalField = true;
  const legacy = payloadOf(await h.invoke({ playlist_id: PL, replacements: 0, appends: 0, dry_run: true }));
  assert.equal(legacy.playlist_total, 4, 'the legacy spelling still resolves through playlistItemTotal');
});

// --------------------------------------------------------------- writes

test('a commit that cannot be prompted is refused, and writes nothing', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub, 'unsupported'); // no elicitation capability
  const out = await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false });
  const body = payloadOf(out);
  assert.equal(body.ok, false);
  assert.equal(body.cancelled, true);
  assert.equal(body.reason, 'confirmation_unavailable');
  assert.deepEqual(writes(stub), [], 'a refusal writes nothing');
});

test('a declined confirmation writes nothing', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub, 'decline');
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false }));
  assert.equal(body.cancelled, true);
  assert.deepEqual(writes(stub), []);
});

test('a confirmation prompt that fails on the wire is a refusal, not a silent proceed', async () => {
  const stub = staleScenario();
  const h = makeHarness(stub, 'error');
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false }));
  assert.equal(body.cancelled, true);
  assert.equal(body.reason, 'elicitation_failed');
  assert.deepEqual(writes(stub), []);
});

test('the commit asks even for a small plan — there is no threshold', async () => {
  const stub = staleScenario();
  stub.allowWrites = true; // this case asserts ON writes; the dry-run cases do not
  const h = makeHarness(stub, 'confirm');
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 1, appends: 1, dry_run: false }));
  assert.equal(h.prompts.length, 1, 'one prompt, even though only two rows are involved');
  assert.equal(body.ok, true);
});

test('SPOTIFY_MCP_READONLY refuses the commit and writes nothing', async () => {
  const stub = staleScenario();
  process.env[READONLY_ENV] = '1';
  const h = makeHarness(stub, 'confirm');
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false }));
  assert.equal(body.ok, false);
  assert.equal(body.blocked, 'read_only_mode');
  assert.deepEqual(writes(stub), []);
  assert.equal(h.prompts.length, 0, 'read-only mode refuses before it would have prompted');
});

test('an empty plan applies nothing and asks nothing', async () => {
  const stub = makeStub();
  stub.rows = [{ uri: `spotify:track:${ID(3)}`, name: 'Current' }];
  stub.total = 1;
  installFixtures([streamRow(ID(3), 'Current', 'Fresh Face', daysAgo(1))]);
  const h = makeHarness(stub, 'confirm');
  const body = payloadOf(await h.invoke({ playlist_id: PL, replacements: 5, appends: 5, dry_run: false }));
  assert.equal(body.applied, false);
  assert.equal(body.no_op_reason, 'nothing_proposed');
  assert.deepEqual(writes(stub), []);
  assert.equal(h.prompts.length, 0);
});

test('the commit removes by DESCENDING position and adds after', async () => {
  const stub = staleScenario();
  stub.allowWrites = true; // this case asserts ON writes; the dry-run cases do not
  const h = makeHarness(stub, 'confirm');
  const out = await h.invoke({ playlist_id: PL, replacements: 3, appends: 2, dry_run: false });
  const body = payloadOf(out);

  assert.equal(body.applied, true);
  const del = writes(stub).filter((c) => c.method === 'delete');
  const post = writes(stub).filter((c) => c.method === 'post');
  assert.equal(del.length, 1, 'three removals fit in one request');
  assert.equal(post.length, 1, 'two additions fit in one request');
  assert.ok(
    stub.calls.indexOf(del[0]!) < stub.calls.indexOf(post[0]!),
    'removals land before additions, so the add does not inherit shifted positions',
  );

  const positions = (del[0]!.body as { tracks: Array<{ positions: number[] }> }).tracks.map((t) => t.positions[0]!);
  assert.deepEqual(positions, [...positions].sort((a, b) => b - a), 'positions are removed from the tail backwards');
  // Every removed position must be one the plan actually proposed, and each
  // uri must match the position it was removed from.
  const proposed = (body.proposed as { replacements: Array<{ position: number; uri: string }> }).replacements;
  for (const t of (del[0]!.body as { tracks: Array<{ uri: string; positions: number[] }> }).tracks) {
    const row = proposed.find((p) => p.uri === t.uri);
    assert.ok(row, `${t.uri} was proposed`);
    assert.equal(t.positions[0], row.position, 'the wire position is the one the plan read');
  }
});

test('the commit issues two receipts, and the final total is the MEASURED one', async () => {
  const stub = staleScenario();
  stub.allowWrites = true; // this case asserts ON writes; the dry-run cases do not
  const h = makeHarness(stub, 'confirm');
  const out = await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false });
  const body = payloadOf(out);

  const receipts = body.receipts as Array<{ receipt_id: string; before: number | null; after: number | null }>;
  assert.equal(receipts.length, 2, 'the removals and the adds are separate mutations with separate inverses');
  assert.equal(receipts[0]?.before, 4, 'the first receipt records the count the plan read');
  assert.equal(receipts[1]?.before, 2, 'the second records the count the removals left behind');
  assert.equal(
    body.playlist_total_after,
    4,
    'the stub still reports total 4, and the figure is that measurement — not plan.total - removed + added',
  );
  assert.equal(body.playlist_total_after_unreadable, false);
  assert.match(String(body.undo_order), /newest first/);
});

test('an unverifiable after-count is null, not a number computed from the plan', async () => {
  const stub = staleScenario();
  // The verification walk inside issueReceipt sees pages that carry no `total`,
  // so the receipt cannot record a measured `after`.
  stub.hideTotal = true;
  stub.allowWrites = true; // this case asserts ON writes; the dry-run cases do not
  const h = makeHarness(stub, 'confirm');
  const out = await h.invoke({ playlist_id: PL, replacements: 2, appends: 2, dry_run: false });
  const body = payloadOf(out);
  assert.equal(body.applied, true, 'the writes landed');
  assert.equal(body.removed, 2);
  assert.equal(body.added, 2);
  const receipts = body.receipts as Array<{ after: number | null }>;
  for (const r of receipts) {
    assert.equal(r.after, null, 'no receipt invents an after-count the walk did not report');
  }
  assert.equal(body.playlist_total_after, null, 'the final total is null, not 4 - 2 + 2');
  assert.equal(body.playlist_total_after_unreadable, true);
  assert.match(textOf(out), /the verification read carried no total/);
});

test('the applied response repeats the disclosure notes, not just the plan', async () => {
  const stub = makeStub();
  stub.rows = [{ uri: `spotify:track:${ID(1)}`, name: 'Old' }];
  stub.total = 1;
  stub.allowWrites = true;
  installFixtures([streamRow(ID(10), 'New A', 'Fresh Face', daysAgo(1))]);
  const h = makeHarness(stub, 'confirm');
  const text = textOf(await h.invoke({ playlist_id: PL, replacements: 1, appends: 0, dry_run: false }));
  assert.match(text, /does not reach back to the window start/);
  assert.match(text, /undo_mutation/);
});
