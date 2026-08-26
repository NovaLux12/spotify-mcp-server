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
import type { SpotifyClient } from '../src/client.js';
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
}

interface RegisteredTool {
  name: string;
  description: string;
  validate: (args: Record<string, unknown>) => Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: { ok?: boolean; rows?: DoctorRow[] };
  }>;
}

interface StubRateLimit {
  lastThrottleAt: number | null;
  retryAfterSec: number | null;
  cooldownRemainingMs: number;
}

function harness(opts: { rateLimit?: StubRateLimit; omitRateLimit?: boolean } = {}) {
  const registered: RegisteredTool[] = [];
  const fakeServer = {
    tool(
      name: string,
      description: string,
      schema: z.ZodRawShape,
      handler: RegisteredTool['handler'],
    ) {
      registered.push({
        name,
        description,
        validate: (args) => z.object(schema).parse(args),
        handler,
      });
    },
  } as unknown as McpServer;

  const client = (
    opts.omitRateLimit ? {} : { getRateLimitStatus: () => opts.rateLimit ?? { lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 } }
  ) as unknown as SpotifyClient;

  registerDoctorTool(fakeServer, client);

  return {
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
    assert.deepEqual(tool.validate({ bogus: 1 }), {});
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

  it('scope mismatch → warn row listing missing write scopes', async () => {
    await writeTokenFile({ ...VALID_TOKENS(), scope: 'user-read-private user-library-read' });
    const { invoke } = harness();
    const res = await invoke();
    const row = res.structuredContent?.rows?.find((r) => r.id === 'scopes');
    assert.equal(row?.status, 'warn');
    assert.match(row!.summary, /lack required scopes/);
    assert.match(row!.detail!, /playlist-modify-public/);
    assert.match(row!.detail!, /user-modify-playback-state/);
    assert.match(row!.detail!, /user-library-modify/);
    assert.match(row!.detail!, /user-follow-modify/);
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

  it('json mode: structuredContent carries raw rows; prose renders status glyphs', async () => {
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
});
