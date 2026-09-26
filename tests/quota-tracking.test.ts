/**
 * Tests for issue #904 — request/quota tracking with pre-flight.
 *
 * Scope: real SpotifyClient counters (cumulative + rolling window), the
 * cooldown pre-flight gate (0 requests + named wait), requests_made on the
 * four named scan payloads, and cumulative/windowed counts in the doctor
 * and rate-limit resource readers. The real client is used (token fixtures
 * in tmpdir); scan modules are exercised through stub clients carrying the
 * same getRateLimitStatus() shape the real client exposes.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Env setup MUST precede importing src modules (TOKEN_FILE binds at load time).
const tokenDir = await mkdtemp(join(tmpdir(), 'spotify-mcp-quota-test-'));
process.env.SPOTIFY_MCP_TOKEN_FILE = join(tokenDir, 'tokens.json');
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
// These tests invoke whats_new, which advances the freshness watermark on a
// completed scan. Unset, it writes to the real ~/.spotify-mcp/freshness.json —
// so `npm test` mutated the developer's own state, and two suites running at
// once raced on that one file (#1130). Point it into this file's tmpdir.
process.env.SPOTIFY_MCP_FRESHNESS_STATE = join(tokenDir, 'freshness.json');

const { SpotifyClient } = await import('../src/client.js');
const { registerLibraryHygieneTools } = await import('../src/tools/libraryhygiene.js');
const { registerSavedDedupeTools } = await import('../src/tools/saveddedupe.js');
const { registerFreshnessTools } = await import('../src/tools/freshness.js');
const { registerExhaust2MiscTools } = await import('../src/tools/exhaust2_misc.js');
const { registerDoctorTool } = await import('../src/tools/doctortool.js');

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function captureOne(
  register: (s: McpServer, c: never) => void,
  client: Record<string, unknown>,
  toolName: string,
): Handler {
  let captured: Handler | undefined;
  const server = {
    tool(name: string, _d: string, _s: unknown, handler: Handler) {
      if (name === toolName) captured = handler;
    },
    resource() {},
  } as unknown as McpServer;
  register(server, client as never);
  assert.ok(captured, `tool ${toolName} not registered`);
  return captured;
}

// --- real-client counter tests --------------------------------------------

interface FetchCall { url: string; init: RequestInit }
let calls: FetchCall[] = [];
let responder: (url: string) => Response;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200, headers?: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers });

async function seedTokens(): Promise<void> {
  await writeFile(process.env.SPOTIFY_MCP_TOKEN_FILE!, JSON.stringify({
    access_token: 'tok', refresh_token: 'ref', expires_at: Date.now() + 3600_000,
  }), 'utf8');
}

describe('SpotifyClient request counters (#904)', () => {
  beforeEach(async () => {
    calls = [];
    responder = () => json({});
    await rm(process.env.SPOTIFY_MCP_TOKEN_FILE!, { force: true });
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return responder(String(url));
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('counts drained requests cumulatively and in rolling windows', async () => {
    await seedTokens();
    responder = () => json({ ok: true });
    const client = new SpotifyClient({ disableCache: true });
    await client.get('/me');
    await client.get('/me/player');
    const status = client.getRateLimitStatus();
    assert.equal(status.requestsTotal, 2);
    assert.equal(status.requestsLastMinute, 2);
    assert.equal(status.requestsLastHour, 2);
    assert.equal(client.requestsSince(60_000), 2);
    assert.equal(client.requestsSince(3_600_000), 2);
  });

  it('a fresh client reports zero counts without changing the legacy fields', async () => {
    await seedTokens();
    const client = new SpotifyClient({ disableCache: true });
    const status = client.getRateLimitStatus();
    assert.equal(status.requestsTotal, 0);
    assert.equal(status.requestsLastMinute, 0);
    assert.equal(status.requestsLastHour, 0);
    assert.equal(status.lastThrottleAt, null);
    assert.equal(status.retryAfterSec, null);
    assert.equal(status.cooldownRemainingMs, 0);
  });
});

// --- pre-flight: cooldown blocks with 0 requests ---------------------------

function stubClient(opts: {
  cooldownMs?: number;
  totals?: { total: number; min: number; hour: number };
  getAllPages?: (path: string) => unknown[];
  get?: (path: string) => unknown;
} = {}) {
  const calls: Array<{ path: string }> = [];
  const status = {
    lastThrottleAt: opts.cooldownMs ? Date.now() : null,
    retryAfterSec: opts.cooldownMs ? 5 : null,
    cooldownRemainingMs: opts.cooldownMs ?? 0,
    requestsTotal: opts.totals?.total ?? 0,
    requestsLastMinute: opts.totals?.min ?? 0,
    requestsLastHour: opts.totals?.hour ?? 0,
  };
  return {
    calls,
    getRateLimitStatus: () => ({ ...status }),
    getAllPages: mock.fn(async (path: string) => {
      calls.push({ path });
      return opts.getAllPages?.(path) ?? [];
    }),
    get: mock.fn(async (path: string) => {
      calls.push({ path });
      return (opts.get?.(path) ?? null) as null;
    }),
  };
}

describe('quota pre-flight blocks heavy scans during a cooldown (#904)', () => {
  it('library_hygiene returns the cooldown message and issues 0 requests', async () => {
    const client = stubClient({ cooldownMs: 4200 });
    const h = captureOne(registerLibraryHygieneTools, client, 'library_hygiene');
    const res = await h({ response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.match(res.content[0].text, /~5s|5s/);
    assert.equal(client.calls.length, 0);
    assert.equal((res.structuredContent as { requests_made: number }).requests_made, 0);
  });

  it('find_duplicate_saved_tracks returns the cooldown message and issues 0 requests', async () => {
    const client = stubClient({ cooldownMs: 9000 });
    const h = captureOne(registerSavedDedupeTools, client, 'find_duplicate_saved_tracks');
    const res = await h({ response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.match(res.content[0].text, /9s/);
    assert.equal(client.calls.length, 0);
    assert.equal((res.structuredContent as { requests_made: number }).requests_made, 0);
  });

  it('whats_new returns the cooldown message and issues 0 requests', async () => {
    const client = stubClient({ cooldownMs: 3000 });
    const h = captureOne(registerFreshnessTools, client, 'whats_new');
    const res = await h({ since: '2026-08-01', response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.equal(client.calls.length, 0);
  });

  it('dead_library_finder returns the cooldown message and issues 0 requests', async () => {
    const client = stubClient({ cooldownMs: 6000 });
    const h = captureOne(registerExhaust2MiscTools, client, 'dead_library_finder');
    const res = await h({ dry_run: true, response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.equal(client.calls.length, 0);
  });

  it('playlist_staleness_report returns the cooldown message and issues 0 requests', async () => {
    const client = stubClient({ cooldownMs: 6000 });
    const h = captureOne(registerExhaust2MiscTools, client, 'playlist_staleness_report');
    const res = await h({ limit: 10, response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.equal(client.calls.length, 0);
  });
});

// --- real-client integration: 3 mocked 429s gate the next heavy tool ------

describe('3 mocked 429s gate the next heavy tool at 0 requests (#904)', () => {
  beforeEach(async () => {
    calls = [];
    responder = () => json({});
    await rm(process.env.SPOTIFY_MCP_TOKEN_FILE!, { force: true });
    globalThis.fetch = (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return responder(String(url));
    }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('after 3 QUOTA_EXCEEDED 429s, library_hygiene returns the cooldown message with 0 new client calls', async () => {
    await seedTokens();
    let n429 = 0;
    const client = new SpotifyClient({ disableCache: true });
    // Three quota-wall hits arm the shared cooldown. NOTE: the drain queue
    // sleeps out the remaining cooldown before each subsequent task, so the
    // mocked Retry-After must stay small (2s) — a production-size value
    // would park the test inside backoff sleeps for that long.
    responder = () => {
      n429++;
      return json(
        { error: { status: 429, message: 'Too many requests', reason: 'QUOTA_EXCEEDED' } },
        429,
        { 'Retry-After': '2' },
      );
    };
    for (let i = 0; i < 3; i++) {
      await assert.rejects(client.get('/me'), /quota exceeded/i);
    }
    assert.equal(n429, 3);
    const status = client.getRateLimitStatus();
    assert.ok(status.cooldownRemainingMs > 0, 'cooldown must be active after quota 429s');

    const before = calls.filter((c) => !c.url.startsWith('https://accounts.spotify.com/')).length;
    const h = captureOne(registerLibraryHygieneTools, client as never, 'library_hygiene');
    const res = await h({ response_format: 'concise' });
    assert.match(res.content[0].text, /Rate-limit cooldown active/);
    assert.match(res.content[0].text, /cooldownRemainingMs=\d+ms/);
    const after = calls.filter((c) => !c.url.startsWith('https://accounts.spotify.com/')).length;
    assert.equal(after, before, 'blocked scan must issue 0 client calls');
    assert.equal((res.structuredContent as { requests_made: number }).requests_made, 0);
  });
});

// --- requests_made on the four named payloads -------------------------------

describe('heavy-scan payloads carry requests_made (#904)', () => {
  it('library_hygiene payload includes requests_made', async () => {
    const client = stubClient({
      getAllPages: () => [],
      get: () => null,
    });
    const h = captureOne(registerLibraryHygieneTools, client, 'library_hygiene');
    const res = await h({ response_format: 'concise' });
    assert.equal(typeof (res.structuredContent as { requests_made?: unknown }).requests_made, 'number');
  });

  it('find_duplicate_saved_tracks payload includes requests_made', async () => {
    const client = stubClient({ getAllPages: () => [] });
    const h = captureOne(registerSavedDedupeTools, client, 'find_duplicate_saved_tracks');
    const res = await h({ response_format: 'concise' });
    assert.equal(typeof (res.structuredContent as { requests_made?: unknown }).requests_made, 'number');
  });

  it('playlist_staleness_report payload includes requests_made', async () => {
    const client = stubClient({ getAllPages: () => [] });
    const h = captureOne(registerExhaust2MiscTools, client, 'playlist_staleness_report');
    const res = await h({ limit: 5, response_format: 'concise' });
    assert.equal(typeof (res.structuredContent as { requests_made?: unknown }).requests_made, 'number');
  });

  it('dead_library_finder payload includes requests_made', async () => {
    const client = stubClient({
      getAllPages: () => [],
      get: () => ({ items: [] }),
    });
    const h = captureOne(registerExhaust2MiscTools, client, 'dead_library_finder');
    const res = await h({ dry_run: true, response_format: 'concise' });
    assert.equal(typeof (res.structuredContent as { requests_made?: unknown }).requests_made, 'number');
  });
});

// --- no cooldown preserves today's budgets ----------------------------------

describe('no cooldown preserves budgets exactly (#904 edge case)', () => {
  it('freshness caps resolve to the requested budget when idle', async () => {
    const seen: string[] = [];
    const client = stubClient({
      getAllPages: (path: string) => {
        seen.push(path);
        return [];
      },
      get: (path: string) => {
        seen.push(path);
        if (path === '/me/following') return { artists: { items: [], total: 0, cursors: null, next: null } };
        return null;
      },
    });
    const h = captureOne(registerFreshnessTools, client, 'whats_new');
    const res = await h({ since: '2026-08-01', max_artists: 25, response_format: 'concise' });
    const payload = res.structuredContent as { lookups: { cap: number; budget: number }; budget_shrunk?: boolean };
    assert.equal(payload.lookups.cap, 25);
    assert.equal(payload.lookups.budget, 25);
    assert.equal(payload.budget_shrunk, undefined);
  });

  it('shrinks the scan budget to the remaining window after recent throttle pressure', async () => {
    // Recent throttle (inside QUOTA_PRESSURE_MS) + spent requests: freshness
    // shrinks max_artists to fetchAllCap - spent instead of the requested budget.
    const client = stubClient({
      cooldownMs: 0,
      totals: { total: 490, min: 490, hour: 490 },
      getAllPages: () => [],
      get: (path: string) => {
        if (path === '/me/following') return { artists: { items: [], total: 0, cursors: null, next: null } };
        return null;
      },
    });
    // Mark the throttle recent: stub reports lastThrottleAt=now via cooldownMs path — instead
    // override the status so lastThrottleAt is fresh but no cooldown is active.
    const base = client.getRateLimitStatus;
    client.getRateLimitStatus = () => ({ ...base(), lastThrottleAt: Date.now(), cooldownRemainingMs: 0 });
    const h = captureOne(registerFreshnessTools, client, 'whats_new');
    const res = await h({ since: '2026-08-01', max_artists: 25, response_format: 'concise' });
    const payload = res.structuredContent as {
      lookups: { cap: number; budget: number };
      requests_planned?: number;
      budget_shrunk?: boolean;
    };
    // fetchAllCap default 500 - 490 spent = 10 remaining < requested 25.
    assert.equal(payload.lookups.cap, 10);
    assert.equal(payload.requests_planned, 11);
    assert.equal(payload.budget_shrunk, true);
  });

  it('library_hygiene still walks the full lookup cap when idle', async () => {
    const client = stubClient({ getAllPages: () => [], get: () => null });
    const h = captureOne(registerLibraryHygieneTools, client, 'library_hygiene');
    const res = await h({ response_format: 'concise' });
    const payload = res.structuredContent as { album_lookups: { cap: number }; budget_shrunk?: boolean };
    assert.equal(payload.album_lookups.cap, 200);
    assert.equal(payload.budget_shrunk, undefined);
  });
});

// --- doctor + resource readers ------------------------------------------------

describe('doctor and rate-limit resource report usage (#904)', () => {
  it('spotify_doctor rate_limit row names cumulative and windowed counts', async () => {
    const registered: Array<{ handler: Handler; schema: z.ZodRawShape }> = [];
    const server = {
      tool(_n: string, _d: string, schema: z.ZodRawShape, handler: Handler) {
        registered.push({ handler, schema });
      },
    } as unknown as McpServer;
    const client = stubClient({ totals: { total: 730, min: 42, hour: 700 } });
    registerDoctorTool(server, client as never);
    const t = registered[0];
    const res = await t.handler(z.object(t.schema).parse({}));
    const row = (res.structuredContent as { rows: Array<{ id: string; summary: string }> }).rows
      .find((r) => r.id === 'rate_limit');
    assert.ok(row, 'rate_limit row present');
    assert.match(row.summary, /requests_total=730/);
    assert.match(row.summary, /requests_last_min=42/);
    assert.match(row.summary, /requests_last_hour=700/);
  });
});
