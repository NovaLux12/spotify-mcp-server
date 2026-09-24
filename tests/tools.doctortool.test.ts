/**
 * Tests for src/tools/doctortool.ts (#111 idea 9).
 *
 * Stub MCP server + stub SpotifyClient; token fixtures live in a per-test
 * temp dir rebound through initConfig({ SPOTIFY_MCP_TOKEN_FILE }) so nothing
 * touches the real ~/.spotify-mcp/tokens.json.
 *
 * Run: node --import tsx --test tests/tools.doctortool.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyApiError, type SpotifyClient } from '../src/client.js';
import { initConfig } from '../src/config.js';
import { registerDoctorTool } from '../src/tools/doctortool.js';

// ---------------------------------------------------------------------------
// Stub plumbing (mirrors tests/tools.users.test.ts)
// ---------------------------------------------------------------------------

interface DoctorRow {
  id: string;
  status: string;
  summary: string;
  detail?: string;
  phase?: string;
  message?: string;
}

interface DoctorSurface {
  registry_available: boolean;
  registered_tools: number;
  total_modules: number;
  active_modules: string[];
  exposed_modules: string[];
  hidden_by_trim: string[];
  hidden_by_scopes: string[];
  hidden_by_readonly: string[];
  active_sets: string[];
  inactive_sets: string[];
  unknown_toolsets: string[];
  enable_overrides: string[];
  disable_overrides: string[];
  unknown_enable_overrides: string[];
  unknown_disable_overrides: string[];
  read_only: boolean;
}

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: { ok?: boolean; rows?: DoctorRow[]; surface?: DoctorSurface };
  }>;
}

interface StubRateLimit {
  lastThrottleAt: number | null;
  retryAfterSec: number | null;
  cooldownRemainingMs: number;
}

function harness(opts: {
  rateLimit?: StubRateLimit;
  omitRateLimit?: boolean;
  seededTools?: number;
  accountError?: Error;
  account?: { id: string; display_name?: string; product?: string; country?: string };
} = {}) {
  const requestedPaths: string[] = [];
  const registered: RegisteredTool[] = [];
  const registry: Record<string, { enabled?: boolean }> = {};
  if (opts.seededTools) {
    for (let index = 0; index < opts.seededTools; index += 1) {
      registry[`seed_tool_${index}`] = { enabled: true };
    }
  }
  const fakeServer = {
    _registeredTools: registry,
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registry[name] = { enabled: true };
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  const client = ({
    ...(opts.omitRateLimit ? {} : {
      getRateLimitStatus: () => opts.rateLimit ?? {
        lastThrottleAt: null,
        retryAfterSec: null,
        cooldownRemainingMs: 0,
      },
    }),
    get: async (path: string) => {
      requestedPaths.push(path);
      if (opts.accountError) throw opts.accountError;
      return opts.account ?? { id: 'user-1', display_name: 'Test User', product: 'premium', country: 'US' };
    },
  }) as unknown as SpotifyClient;

  registerDoctorTool(fakeServer, client);

  return {
    requestedPaths,
    registered,
    invoke: async (args: Record<string, unknown> = {}) => {
      const tool = registered.find((t) => t.name === 'spotify_doctor');
      assert.ok(tool, 'spotify_doctor must be registered');
      return tool.handler(tool.validate(args));
    },
  };
}

// ---------------------------------------------------------------------------
// Temp token-file fixture
// ---------------------------------------------------------------------------

let tmpDir: string | null = null;

async function writeTokenFile(content: object): Promise<string> {
  tmpDir = await mkdtemp(join(tmpdir(), 'doctor-test-'));
  const file = join(tmpDir, 'tokens.json');
  await writeFile(file, JSON.stringify(content), 'utf8');
  // Re-bind the process-wide config snapshot to point at the temp file.
  initConfig({ SPOTIFY_MCP_TOKEN_FILE: file });
  return file;
}

beforeEach(() => {
  delete process.env.SPOTIFY_MCP_TOOLSETS;
  delete process.env.SPOTIFY_MCP_ENABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_DISABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_READONLY;
});

afterEach(async () => {
  // Restore config to process.env defaults so later tests are unaffected.
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
  initConfig();
});

const VALID_TOKENS = () => ({
  access_token: 'at',
  refresh_token: 'rt',
  expires_at: Date.now() + 3600_000,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spotify_doctor', () => {
  it('registers exactly one tool named spotify_doctor', () => {
    const { registered } = harness();
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'spotify_doctor');
  });

  it('accepts no args and optional verbose flag', async () => {
    const { invoke } = harness();
    await assert.doesNotReject(() => invoke({}));
    await assert.doesNotReject(() => invoke({ verbose: true }));
    // Unknown keys are stripped by zod (same as SDK-side parsing), not fatal.
    const tool = harness().registered[0];
    assert.deepEqual(tool.validate({ bogus: 1 }), { response_format: 'concise' });
    assert.equal(tool.validate({ verbose: true }).verbose, true);
  });

  it('valid token → pass row with expiry and seconds remaining', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'token');
    assert.ok(row, 'token row present');
    assert.equal(row.status, 'pass');
    assert.match(row.summary, /token valid/);
    assert.match(row.summary, /in \d+h \d+m/);
    assert.ok(res.structuredContent?.ok, 'report ok with no fail rows');
  });

  it('missing token file → fail row, report not ok', async () => {
    await writeTokenFile(VALID_TOKENS());
    await rm(tmpDir!, { recursive: true, force: true }); // remove after binding
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'token');
    assert.ok(row);
    assert.equal(row.status, 'fail');
    assert.match(row.summary, /no token file|unreadable|corrupted/);
    assert.equal(res.structuredContent?.ok, false);
    assert.doesNotReject; // diagnostic never throws — proven by the await above
  });

  it('expired token → warn row', async () => {
    await writeTokenFile({ ...VALID_TOKENS(), expires_at: Date.now() - 60_000 });
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'token');
    assert.equal(row?.status, 'warn');
    assert.match(row!.summary, /EXPIRED/);
  });

  it('missing write scopes removes affected modules from the exposed surface', async () => {
    await writeTokenFile({ ...VALID_TOKENS(), scope: 'user-read-private user-library-read' });
    const { invoke } = harness();
    const report = (await invoke({ response_format: 'json' })).structuredContent;
    assert.ok(report?.surface?.hidden_by_scopes.includes('playback'));
    assert.ok(report?.surface?.hidden_by_scopes.includes('playlists'));
    assert.ok(report?.surface?.hidden_by_scopes.includes('library'));
    assert.ok(report?.surface?.hidden_by_scopes.includes('following'));
    assert.ok(!report?.surface?.exposed_modules.includes('playback'));
  });

  it('full grant scope → scopes pass row', async () => {
    const full =
      'user-read-private user-modify-playback-state playlist-modify-public playlist-modify-private user-library-modify user-follow-modify';
    await writeTokenFile({ ...VALID_TOKENS(), scope: full });
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'scopes');
    assert.equal(row?.status, 'pass');
  });

  it('pre-upgrade token without scope field → scopes-unknown warn', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'scopes');
    assert.equal(row?.status, 'warn');
    assert.match(row!.summary, /scopes unknown \(pre-upgrade token file\)/);
  });

  it('inactive toolset removes its scope requirement from the gap list', async () => {
    process.env.SPOTIFY_MCP_TOOLSETS = 'playback';
    await writeTokenFile({ ...VALID_TOKENS(), scope: '' });
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'scopes');
    assert.equal(row?.status, 'warn');
    assert.match(row!.detail!, /user-modify-playback-state/);
    assert.doesNotMatch(row!.detail!, /playlist-modify-public/);
  });

  it('rate-limit cooldown surfaces as warn row; idle client passes', async () => {
    await writeTokenFile(VALID_TOKENS());
    const throttled = harness({ rateLimit: { lastThrottleAt: Date.now(), retryAfterSec: 5, cooldownRemainingMs: 4200 } });
    let row = (await throttled.invoke()).structuredContent?.rows?.find((r) => r.id === 'rate_limit');
    assert.equal(row?.status, 'warn');
    assert.match(row!.summary, /cooldown active/);

    const idle = harness();
    row = (await idle.invoke()).structuredContent?.rows?.find((r) => r.id === 'rate_limit');
    assert.equal(row?.status, 'pass');

    // Clients without the accessor skip the row entirely.
    const bare = harness({ omitRateLimit: true });
    row = (await bare.invoke()).structuredContent?.rows?.find((r) => r.id === 'rate_limit');
    assert.equal(row, undefined);
  });

  it('config snapshot row reflects bound config', async () => {
    const file = await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'config');
    assert.ok(row);
    assert.match(row.summary, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(row.summary, /fetch_all_cap=500 max_items=50/);
  });

  it('premium info row always present and points at get_me.product', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'premium');
    assert.equal(row?.status, 'info');
    assert.match(row!.summary, /get_me/);
  });

  it('structured content carries diagnostic rows while prose renders status glyphs', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const res = await invoke({ verbose: true });
    const rows = res.structuredContent?.rows;
    assert.ok(Array.isArray(rows) && rows.length >= 4);
    for (const r of rows) {
      assert.equal(typeof r.id, 'string');
      assert.ok(['pass', 'fail', 'warn', 'info'].includes(r.status));
      assert.equal(typeof r.summary, 'string');
    }
    const text = res.content[0].text;
    assert.match(text, /✓ \[token\]/);
    assert.match(text, /Spotify doctor/);
  });

  it('verbose prose includes detail lines; concise omits them', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const verbose = await invoke({ verbose: true });
    assert.match(verbose.content[0].text, /seconds_remaining=/);
    const concise = await invoke({});
    assert.doesNotMatch(concise.content[0].text, /seconds_remaining=/);
  });

  it('json text parses to the same report object exposed as structuredContent', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness({ seededTools: 3 });
    const res = await invoke({ response_format: 'json' });
    assert.deepEqual(JSON.parse(res.content[0].text), res.structuredContent);
  });

  it('concise and detailed render the same report with distinct detail visibility', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness();
    const concise = await invoke({ response_format: 'concise' });
    const detailed = await invoke({ response_format: 'detailed' });
    assert.equal(concise.structuredContent?.surface?.registered_tools, 1);
    assert.match(concise.content[0].text, /Spotify doctor/);
    assert.doesNotMatch(concise.content[0].text, /seconds_remaining=/);
    assert.match(detailed.content[0].text, /seconds_remaining=/);
    assert.deepEqual(
      concise.structuredContent?.surface?.registered_tools,
      detailed.structuredContent?.surface?.registered_tools,
    );
  });

  it('surfaces 401 probe failures and makes the report unhealthy', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke } = harness({ accountError: new SpotifyApiError(401, 'token expired') });
    const res = await invoke({ response_format: 'json' });
    const row = res.structuredContent?.rows?.find((candidate) => candidate.id === 'account_probe');
    assert.equal(res.structuredContent?.ok, false);
    assert.equal(row?.status, 'fail');
    assert.equal(row?.phase, 'account_probe');
    assert.match(row?.message ?? '', /401 token expired/);
    assert.doesNotMatch(res.content[0].text, /no failures/);
  });

  it('surfaces 429 and network probe outcomes without hiding their phases', async () => {
    await writeTokenFile(VALID_TOKENS());
    const throttled = harness({ accountError: new SpotifyApiError(429, 'rate limited', 7) });
    let res = await throttled.invoke({ response_format: 'json' });
    let row = res.structuredContent?.rows?.find((candidate) => candidate.id === 'account_probe');
    assert.equal(res.structuredContent?.ok, true);
    assert.equal(row?.status, 'warn');
    assert.match(row?.summary ?? '', /429.*retry after 7s/);

    const offline = harness({ accountError: new TypeError('fetch failed') });
    res = await offline.invoke({ response_format: 'json' });
    row = res.structuredContent?.rows?.find((candidate) => candidate.id === 'account_probe');
    assert.equal(res.structuredContent?.ok, true);
    assert.equal(row?.status, 'info');
    assert.match(row?.summary ?? '', /live probe skipped \(network\)/);
  });

  it('reports live tool count plus internally consistent trim and scope state', async () => {
    await writeTokenFile({ ...VALID_TOKENS(), scope: 'user-read-private' });
    process.env.SPOTIFY_MCP_TOOLSETS = 'playback';
    const { invoke } = harness({ seededTools: 2 });
    const surface = (await invoke({ response_format: 'json' })).structuredContent?.surface;
    assert.ok(surface);
    assert.equal(surface.registry_available, true);
    assert.equal(surface.registered_tools, 3);
    assert.deepEqual(surface.active_sets, ['playback']);
    assert.ok(surface.hidden_by_trim.includes('library'));
    assert.ok(surface.hidden_by_scopes.includes('playback'));
    assert.equal(surface.active_modules.length + surface.hidden_by_trim.length, surface.total_modules);
    assert.equal(
      surface.exposed_modules.length,
      surface.active_modules.length - surface.hidden_by_scopes.length - surface.hidden_by_readonly.length,
    );
  });

  it('names unknown-only trimming instead of implying a healthy full surface', async () => {
    await writeTokenFile(VALID_TOKENS());
    process.env.SPOTIFY_MCP_TOOLSETS = 'bogus_set';
    const { invoke } = harness({ seededTools: 3 });
    const res = await invoke({ response_format: 'detailed' });
    assert.equal(res.structuredContent?.surface?.registered_tools, 4);
    assert.deepEqual(res.structuredContent?.surface?.active_sets, []);
    assert.deepEqual(res.structuredContent?.surface?.unknown_toolsets, ['bogus_set']);
    assert.match(res.content[0].text, /unknown_toolsets=bogus_set/);
  });

  it('reports enable and disable override state and honors READONLY trimming', async () => {
    await writeTokenFile(VALID_TOKENS());
    process.env.SPOTIFY_MCP_TOOLSETS = 'playback';
    process.env.SPOTIFY_MCP_ENABLE_TOOLS = 'library';
    process.env.SPOTIFY_MCP_DISABLE_TOOLS = 'playback';
    process.env.SPOTIFY_MCP_READONLY = 'true';
    const { invoke } = harness();
    const surface = (await invoke({ response_format: 'json' })).structuredContent?.surface;
    assert.deepEqual(surface?.active_sets, ['playback']);
    assert.deepEqual(surface?.enable_overrides, ['library']);
    assert.deepEqual(surface?.disable_overrides, ['playback']);
    assert.equal(surface?.read_only, true);
    assert.ok(surface?.active_modules.includes('library'));
    assert.ok(!surface?.active_modules.includes('playback'));
    assert.ok(!surface?.exposed_modules.includes('library'));
  });

  it('issues only the account read probe and no mutation request', async () => {
    await writeTokenFile(VALID_TOKENS());
    const { invoke, requestedPaths } = harness();
    await invoke();
    assert.deepEqual(requestedPaths, ['/me']);
  });
});
