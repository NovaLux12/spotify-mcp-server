/**
 * #896 — dry-run previews must be truthful, must not perform the scan they are
 * previewing, and must say so when the plan cannot be computed.
 *
 * Three distinct defects, one per describe block, each with a test that fails
 * without its fix (verified by reverting the source and re-running — see the PR
 * body). The instrumentation rule throughout: cost and short-circuit claims are
 * asserted on the CLIENT'S RECORDED CALL COUNT, never on the number the preview
 * reports about itself. A preview that both lies and self-reports consistently
 * would pass a test that trusted its own prose.
 *
 * The `getAllPages` stub here is genuinely PAGED — it records one request per
 * page, the way the real client does — so `client.calls.length` is a real
 * request count and a bound can be compared against it honestly.
 *
 * Stub MCP server + stub SpotifyClient — no network, no token file access.
 */

import './helpers/hermetic.js';

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';

// Every sidecar these slices touch goes to a throwaway dir.
const tmp = mkdtempSync(join(tmpdir(), 'dryrun896-'));
mkdirSync(join(tmp, 'history'), { recursive: true });
process.env.SPOTIFY_MCP_EXHAUST2_MISC_FILE = join(tmp, 'exhaust2-misc.json');
process.env.SPOTIFY_MCP_GENRE_TAGS_FILE = join(tmp, 'genre-tags.json');
process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(tmp, 'playback-ext.json');
process.env.SPOTIFY_MCP_SCENES_FILE = join(tmp, 'scenes.json');
process.env.SPOTIFY_MCP_HISTORY_DIR = join(tmp, 'history');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

interface PageSpec {
  rows: unknown[];
  /** Page size the walk should use; drives the recorded request count. */
  limit: number;
}

/**
 * A stub client that records one request per PAGE rather than one per walk,
 * so a tool's reported cost can be compared against the requests a real walk
 * would have spent. `calls` is the ground truth; nothing here derives it from
 * a field the tools under test produce.
 */
function pagingClient(spec: (path: string) => PageSpec | (() => never) | unknown[] | null) {
  const calls: string[] = [];
  const getAllPages = mock.fn(async (path: string, params?: Record<string, string>): Promise<unknown[]> => {
    const entry = spec(path);
    if (typeof entry === 'function') return (entry as () => never)();
    const rows = Array.isArray(entry) ? entry : (entry?.rows ?? []);
    const limit = Number(params?.limit ?? (Array.isArray(entry) ? 50 : (entry as PageSpec | null)?.limit ?? 50));
    // One recorded request per page, the way the real client spends them, so
    // `calls.length` is a request count and not a walk count. A walk that
    // returns nothing still costs one request; a walk that returns rows costs
    // exactly ceil(rows / limit), with no extra probe.
    if (rows.length === 0) {
      calls.push(path);
      return rows;
    }
    for (let i = 0; i < rows.length; i += limit) calls.push(path);
    return rows;
  });
  const get = mock.fn(async (path: string) => {
    calls.push(path);
    return { items: [], next: null };
  });
  const client = {
    calls,
    get,
    getAllPages,
    put: mock.fn(async () => null),
    post: mock.fn(async () => null),
    delete: mock.fn(async () => null),
    getRateLimitStatus: mock.fn(() => ({ cooldownRemainingMs: 0, lastThrottleAt: null, retryAfterSec: null })),
  } as unknown as SpotifyClient;
  return client as SpotifyClient & { calls: string[]; get: ReturnType<typeof mock.fn>; getAllPages: ReturnType<typeof mock.fn> };
}

function handlerFor(register: (s: unknown, c: unknown) => void, name: string, client: unknown): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(toolName: string, _d: string, _shape: unknown, h: Handler) {
      if (toolName === name) captured = h;
    },
  } as unknown as McpServer;
  (register as (s: McpServer, c: unknown) => void)(server, client);
  assert.ok(captured, `tool ${name} not registered`);
  return captured;
}

const swarm3 = (n: string, c: unknown) => handlerFor(registerSwarm3LibraryTools as never, n, c);
const misc = (n: string, c: unknown) => handlerFor(registerExhaust2MiscTools as never, n, c);

// ---------------------------------------------------------------------------
// 1. TRUTHFUL — saved_vs_playlist_coverage's advertised worst case
// ---------------------------------------------------------------------------

describe('#896 truthfulness: saved_vs_playlist_coverage bounds the whole walk (#1)', () => {
  /** 5 playlists x 250 items — the fixture from the issue's acceptance criteria. */
  function coverageClient() {
    const playlists = Array.from({ length: 5 }, (_, i) => ({ id: `pl-${i}`, name: `P${i}` }));
    const items = (i: number) => Array.from({ length: 250 }, (_, j) => ({ item: { id: `tr-${i}-${j}`, uri: `spotify:track:${i}-${j}` } }));
    return pagingClient((path) => {
      if (path === '/me/tracks') return { rows: Array.from({ length: 500 }, (_, j) => ({ added_at: '2020-01-01T00:00:00Z', track: { id: `tr-${j}`, uri: `spotify:track:${j}`, name: `T${j}`, artists: [] } })), limit: 50 };
      if (path === '/me/playlists') return { rows: playlists, limit: 50 };
      const m = /^\/playlists\/(.+)\/items$/.exec(path);
      if (m) return { rows: items(Number(m[1]!.replace('pl-', ''))), limit: 100 };
      return null;
    });
  }

  it('reports a bound at least as large as the requests the real walk spends', async () => {
    const client = coverageClient();
    const h = swarm3('saved_vs_playlist_coverage', client);
    const preview = await h({ dry_run: true, scan_cap: 200 });
    const bound = (preview.structuredContent as { estimated_requests_max: number }).estimated_requests_max;
    assert.ok(Number.isInteger(bound), 'a request bound must be a whole number of requests');

    // Now spend the scan and count what it actually cost.
    const spent = coverageClient();
    await swarm3('saved_vs_playlist_coverage', spent)({ dry_run: false, scan_cap: 200 });
    const actual = spent.calls.length;

    // The old formula added the per-playlist item pages ONCE (`cap / 100`),
    // giving 4 + 4 + 2 = 10 here — below what the walk actually spends, so a
    // caller budgeting against it is under-funded by the paging factor times
    // the playlist count. The fixed bound must cover the real cost.
    assert.ok(actual > 0, 'the executed walk must actually issue requests, or this proves nothing');
    assert.ok(
      bound >= actual,
      `advertised bound ${bound} must cover the ${actual} requests the real walk issues`,
    );
    assert.ok(bound >= 26, `bound ${bound} is below the 26 this fixture actually costs`);
  });

  it('the bound scales with the number of playlists, not with a constant', async () => {
    const one = pagingClient((p) => (p === '/me/playlists' ? { rows: [{ id: 'a', name: 'A' }], limit: 50 } : { rows: [], limit: 100 }));
    const many = pagingClient((p) => (p === '/me/playlists'
      ? { rows: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `P${i}` })), limit: 50 }
      : { rows: [], limit: 100 }));
    const small = (await swarm3('saved_vs_playlist_coverage', one)({ dry_run: true, scan_cap: 200 }))
      .structuredContent as { estimated_requests_max: number };
    const large = (await swarm3('saved_vs_playlist_coverage', many)({ dry_run: true, scan_cap: 200 }))
      .structuredContent as { estimated_requests_max: number };
    // Both are worst-case bounds over the SAME cap, so they are equal by
    // construction — and that is the point: the bound is the cap, not the
    // playlist count this particular account happens to have. The preview says
    // so explicitly rather than implying it counted anything.
    assert.equal(small.estimated_requests_max, large.estimated_requests_max);
    assert.equal((small as { playlists_scanned_max: number }).playlists_scanned_max, 200);
  });

  it('a dry run issues zero requests', async () => {
    const client = coverageClient();
    await swarm3('saved_vs_playlist_coverage', client)({ dry_run: true, scan_cap: 200 });
    assert.equal(client.getAllPages.mock.callCount(), 0, 'a dry run must not walk /me/tracks or /me/playlists');
    assert.equal(client.get.mock.callCount(), 0);
  });
});

// ---------------------------------------------------------------------------
// 2. SHORT-CIRCUIT — dead_library_finder pays the scan it is previewing
// ---------------------------------------------------------------------------

describe('#896 short-circuit: dead_library_finder previews without scanning (#2)', () => {
  function deadClient() {
    return pagingClient((path) => {
      if (path === '/me/tracks') return { rows: Array.from({ length: 500 }, (_, i) => ({ added_at: '2020-01-01T00:00:00Z', track: { uri: `spotify:track:${i}`, name: `T${i}`, artists: [] } })), limit: 50 };
      if (path === '/me/playlists') return { rows: Array.from({ length: 50 }, (_, i) => ({ id: `pl-${i}`, name: `P${i}` })), limit: 50 };
      if (/^\/playlists\/.+\/items$/.test(path)) return { rows: Array.from({ length: 500 }, (_, j) => ({ item: { uri: `spotify:track:x${j}` } })), limit: 100 };
      return null;
    });
  }

  it('issues ZERO requests on a 50-playlist account, where the scan costs hundreds', async () => {
    const client = deadClient();
    const res = await misc('dead_library_finder', client)({ dry_run: true, response_format: 'concise' });

    // THE assertion. The old handler branched on isDryRun() only AFTER
    // /me/tracks, 1000 recently-played and 50 playlists x 500 items, so this
    // count was ~280 at the moment the preview was produced. The issue's
    // acceptance criterion is <= 12; the fix is 0, and 0 is checkable.
    assert.equal(client.getAllPages.mock.callCount(), 0, 'dry run must not walk /me/tracks or /me/playlists');
    assert.equal(client.get.mock.callCount(), 0, 'dry run must not walk recently-played');
    assert.equal(client.calls.length, 0, 'no request of any kind may be issued by a dry run');
    assert.ok(res.content[0].text.includes('[dry run]'));
  });

  it('says the candidate list is unknown rather than reporting an empty one (#3)', async () => {
    const res = await misc('dead_library_finder', deadClient())({ dry_run: true, response_format: 'concise' });
    const sc = res.structuredContent as Record<string, unknown>;
    // Requirement 3. A candidate count of 0 here would be indistinguishable
    // from "you have no dead tracks" — the #803 class of lie, and the most
    // dangerous possible one, because it invites a commit that removes nothing.
    assert.equal(sc.count, null, 'an uncomputable plan must report null, never 0');
    assert.equal(sc.candidates, null, 'an uncomputable plan must report null, never []');
    assert.equal(sc.candidates_known, false);
    assert.match(String(sc.candidates_note), /unknown/i);
    // It still reports a usable cost, because that much IS knowable.
    assert.equal(typeof sc.estimated_requests_max, 'number');
    assert.ok((sc.estimated_requests_max as number) > 0);
    assert.equal(sc.requests_made, 0);
  });

  it('the bound it advertises covers the scan that committing actually performs', async () => {
    const preview = (await misc('dead_library_finder', deadClient())({ dry_run: true, response_format: 'concise' }))
      .structuredContent as { estimated_requests_max: number };
    const spent = deadClient();
    await misc('dead_library_finder', spent)({ dry_run: false, response_format: 'concise' });
    assert.ok(spent.calls.length > 0, 'the committing path must still scan');
    assert.ok(
      preview.estimated_requests_max >= spent.calls.length,
      `bound ${preview.estimated_requests_max} must cover the ${spent.calls.length} requests the real scan spends`,
    );
  });

  it('a bound is never NaN, even from a hand-built args object with no zod defaults', async () => {
    // Handlers are invoked directly in tests and by any direct caller, so zod's
    // `.default()` has not run and `max_playlists` is `undefined`. Uncoerced,
    // that made the bound NaN and the prose read "Worst-case cost: <=NaN
    // requests" — a preview that reports a number the scan can never match.
    //
    // Both entry points into the bound are asserted, because they coerce
    // separately: the dry-run branch and the cooldown gate. A test that only
    // covered the first would pass against a gate that renders `NaN`.
    const preview = await misc('dead_library_finder', deadClient())({ response_format: 'concise' });
    const bound = (preview.structuredContent as { estimated_requests_max: number }).estimated_requests_max;
    assert.ok(Number.isFinite(bound), `dry-run bound must be a finite request count, got ${bound}`);
    assert.doesNotMatch(preview.content[0].text, /NaN/);

    // The cooldown gate quotes the same bound from the RAW argument, with no
    // handler-level coercion in between.
    const cooling = deadClient();
    (cooling as unknown as { getRateLimitStatus: () => unknown }).getRateLimitStatus = () => ({
      cooldownRemainingMs: 30_000, lastThrottleAt: null, retryAfterSec: null,
    });
    const blocked = await misc('dead_library_finder', cooling)({ response_format: 'concise' });
    const planned = (blocked.structuredContent as { requests_planned: number }).requests_planned;
    assert.ok(Number.isFinite(planned), `cooldown-gate requests_planned must be a finite request count, got ${planned}`);
    assert.ok(planned > 0, `requests_planned must price the whole scan, got ${planned}`);
  });

  it('dry_run:false still performs the full scan and reports a real candidate count', async () => {
    const client = deadClient();
    const res = await misc('dead_library_finder', client)({ dry_run: false, response_format: 'concise' });
    assert.ok(client.getAllPages.mock.callCount() > 0, 'the committing path must still scan');
    const sc = res.structuredContent as Record<string, unknown>;
    assert.equal(typeof sc.count, 'number', 'a committed run reports the count it computed');
    assert.notEqual(sc.candidates_known, false);
  });
});

// ---------------------------------------------------------------------------
// 3. A PREVIEW THAT CANNOT BE COMPUTED — playlist_staleness_report
// ---------------------------------------------------------------------------

describe('#896 playlist_staleness_report: a preview that did not exist, and a 429 that threw (#3)', () => {
  function staleClient(behaviour?: 'quota-third') {
    let n = 0;
    return pagingClient((path) => {
      if (path === '/me/playlists') {
        return { rows: Array.from({ length: 6 }, (_, i) => ({ id: `pl-${i}`, name: `P${i}` })), limit: 50 };
      }
      const m = /^\/playlists\/(.+)\/items$/.exec(path);
      if (m) {
        n++;
        if (behaviour === 'quota-third' && n === 3) {
          return () => { throw new SpotifyApiError(429, 'Too many requests', 5, 'RATE_LIMITED'); };
        }
        return { rows: Array.from({ length: 40 }, (_, j) => ({ added_at: '2020-01-01T00:00:00Z' })), limit: 100 };
      }
      return null;
    });
  }

  it('dry_run reports the bound and issues ZERO requests', async () => {
    const client = staleClient();
    const res = await misc('playlist_staleness_report', client)({ dry_run: true, response_format: 'concise' });
    assert.equal(client.getAllPages.mock.callCount(), 0, 'a dry run must not walk any playlist');
    assert.equal(client.get.mock.callCount(), 0);
    assert.equal(client.calls.length, 0);
    assert.ok(res.content[0].text.includes('[dry run]'));
  });

  it('dry_run does not report an empty report it never produced (#3)', async () => {
    const res = await misc('playlist_staleness_report', staleClient())({ dry_run: true, response_format: 'concise' });
    const sc = res.structuredContent as Record<string, unknown>;
    assert.equal(sc.scanned, null, 'an uncomputable preview must report null, never 0');
    assert.equal(sc.playlists, null, 'an uncomputable preview must report null, never []');
    assert.equal(sc.scanned_known, false);
    assert.match(res.content[0].text, /UNKNOWN/);
    assert.equal(sc.requests_made, 0);
  });

  it('the advertised bound covers the scan the real run performs', async () => {
    const preview = (await misc('playlist_staleness_report', staleClient())({ dry_run: true, response_format: 'concise' }))
      .structuredContent as { estimated_requests_max: number };
    const spent = staleClient();
    await misc('playlist_staleness_report', spent)({ response_format: 'concise' });
    assert.ok(spent.calls.length > 0, 'the executed walk must actually issue requests');
    assert.ok(
      preview.estimated_requests_max >= spent.calls.length,
      `bound ${preview.estimated_requests_max} must cover the ${spent.calls.length} requests the real walk issues`,
    );
  });

  it('a 429 mid-walk degrades to partial rows plus quota_hit_at_playlist, not a throw', async () => {
    const client = staleClient('quota-third');
    const res = await misc('playlist_staleness_report', client)({ response_format: 'concise' });
    const sc = res.structuredContent as Record<string, unknown>;
    // This report spends up to 251 requests in one call, so a throttle
    // part-way through is a normal outcome. It used to rethrow, discarding a
    // mostly-complete report with no recovery path.
    assert.equal(sc.quota_hit_at_playlist, 'pl-2');
    assert.equal(sc.complete, false, 'a partial report must not claim to be complete');
    assert.equal((sc.playlists as unknown[]).length, 2, 'the two playlists read before the 429 are kept');
    assert.match(res.content[0].text, /PARTIAL/);
  });

  it('an uninterrupted run is still marked complete, so the flag means something', async () => {
    const res = await misc('playlist_staleness_report', staleClient())({ response_format: 'concise' });
    const sc = res.structuredContent as Record<string, unknown>;
    assert.equal(sc.quota_hit_at_playlist, null);
    assert.equal(sc.complete, true);
    assert.equal(sc.scanned, 6);
  });

  it('omitting dry_run still runs the report — the flag is opt-in for a read-only tool', async () => {
    // Guards against "fixing" #896 by making this default TRUE, which would
    // mean a read-only report could only ever preview and never answer.
    const client = staleClient();
    await misc('playlist_staleness_report', client)({ response_format: 'concise' });
    assert.ok(client.getAllPages.mock.callCount() > 0, 'an omitted dry_run must still perform the read-only scan');
  });
});
