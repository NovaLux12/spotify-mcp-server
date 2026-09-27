/**
 * Regression tests for #681 — the doctor scope check read the wrong object.
 *
 * The check used to filter its requirements by `surface.exposed_modules`,
 * which is the surface with `hidden_by_scopes` already subtracted. A module
 * can only land in `hidden_by_scopes` BECAUSE its write scope is missing, so
 * the filter cancelled the check against its own subject: the larger the gap,
 * the quieter the row. In production it never fired at all — only a token
 * whose `scope` was literally empty, which fails OPEN in
 * `moduleBlockedByScopes` and therefore hides nothing, produced a warn.
 *
 * Every test here states the behaviour the fix has to hold, not the shape of
 * the code that produces it, and each one fails against the pre-fix source.
 *
 * Run: node --import tsx --test tests/doctor-scope-overrides.test.ts
 */

import './helpers/hermetic.js';

import { describe, it, beforeEach, afterEach } from 'node:test';
import { z } from 'zod';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { initConfig, DEFAULT_SCOPES } from '../src/config.js';
import { registerDoctorTool } from '../src/tools/doctortool.js';

interface Row {
  id: string;
  status: string;
  summary: string;
  detail?: string;
}

interface Surface {
  active_modules: string[];
  exposed_modules: string[];
  hidden_by_trim: string[];
  hidden_by_scopes: string[];
  hidden_by_readonly: string[];
  read_only: boolean;
}

function harness() {
  const registered: { name: string; validate: (a: unknown) => unknown; handler: (a: unknown) => Promise<any> }[] = [];
  const fakeServer = {
    _registeredTools: {},
    tool(name: string, _description: string, schema: Record<string, z.ZodTypeAny>, handler: (a: unknown) => Promise<any>) {
      registered.push({ name, validate: (a) => z.object(schema).parse(a), handler });
    },
  } as unknown as McpServer;
  const client = {
    getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
    get: async () => ({ id: 'user-1', display_name: 'Test User', product: 'premium' }),
  } as unknown as SpotifyClient;
  registerDoctorTool(fakeServer, client);
  const tool = registered.find((t) => t.name === 'spotify_doctor');
  assert.ok(tool, 'spotify_doctor must be registered');
  return async () => {
    const res = await tool.handler(tool.validate({ response_format: 'json' }));
    const report = res.structuredContent as { rows: Row[]; surface: Surface };
    const scopeRow = report.rows.find((r) => r.id === 'scopes');
    assert.ok(scopeRow, 'the report must carry a scopes row');
    return { ...report, scopeRow, text: `${scopeRow.summary} ${scopeRow.detail ?? ''}` };
  };
}

let tmpDir: string | null = null;

async function tokenFile(scope: string): Promise<void> {
  tmpDir = await mkdtemp(join(tmpdir(), 'doctor-681-'));
  const file = join(tmpDir, 'tokens.json');
  await writeFile(
    file,
    JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000, scope }),
    'utf8',
  );
  initConfig({ SPOTIFY_MCP_TOKEN_FILE: file });
}

/** The server's real default grant, minus `scope`. */
const without = (...drop: string[]): string =>
  DEFAULT_SCOPES.filter((s) => !drop.includes(s)).join(' ');

beforeEach(() => {
  delete process.env.SPOTIFY_MCP_TOOLSETS;
  delete process.env.SPOTIFY_MCP_ENABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_DISABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_READONLY;
});

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
  initConfig();
  delete process.env.SPOTIFY_MCP_TOOLSETS;
  delete process.env.SPOTIFY_MCP_ENABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_DISABLE_TOOLS;
  delete process.env.SPOTIFY_MCP_READONLY;
});

describe('#681 — the scope check reads the EFFECTIVE surface, not the code default', () => {
  it('reports a scope gap for a module the scope gate hid (the defect itself)', async () => {
    // A real token missing exactly one write scope. The `playback` module is
    // hidden by the gate precisely because `user-modify-playback-state` is
    // absent — which is the finding, not a reason to skip it.
    await tokenFile(without('user-modify-playback-state'));
    const report = await harness()();

    // Non-vacuity: the module really was removed by the scope gate, so this
    // test cannot pass by accident on a surface that still exposes it.
    assert.ok(
      report.surface.hidden_by_scopes.includes('playback'),
      'precondition: the scope gate really did hide the playback module',
    );
    assert.ok(
      !report.surface.exposed_modules.includes('playback'),
      'precondition: and it really is absent from the exposed surface',
    );
    assert.equal(report.scopeRow.status, 'warn', `expected a warn, got: ${report.text}`);
    assert.match(report.text, /user-modify-playback-state/);
  });

  it('honours DISABLE_TOOLS: no gap for a module the operator turned off', async () => {
    process.env.SPOTIFY_MCP_DISABLE_TOOLS = 'playback';
    await tokenFile(without('user-modify-playback-state'));
    const report = await harness()();

    assert.ok(report.surface.hidden_by_trim.includes('playback'), 'precondition: the override trimmed playback');
    assert.doesNotMatch(
      report.scopeRow.detail ?? '',
      /user-modify-playback-state/,
      `still asks for a scope for an unregistered module: ${report.text}`,
    );
    assert.equal(report.scopeRow.status, 'pass', `the trimmed grant should leave no gap: ${report.text}`);
  });

  it('honours ENABLE_TOOLS: a genuine gap on a module forced on is still reported', async () => {
    // The mirror of the case above, and the one that was previously silent:
    // trimming to `catalog` and forcing `library` back on, on a grant that
    // lacks the scope that module needs.
    process.env.SPOTIFY_MCP_TOOLSETS = 'catalog';
    process.env.SPOTIFY_MCP_ENABLE_TOOLS = 'library';
    await tokenFile(without('user-library-modify'));
    const report = await harness()();

    assert.ok(report.surface.active_modules.includes('library'), 'precondition: the override forced library on');
    assert.equal(report.scopeRow.status, 'warn', `expected a warn, got: ${report.text}`);
    assert.match(report.text, /user-library-modify/);
  });

  it('honours the toolset trim: a module outside the active sets is not asked about', async () => {
    // Trimmed to `playback` only. The grant is missing three write scopes, one
    // of which belongs to the one registered module — so the row must warn for
    // playback and stay silent about library and playlists.
    process.env.SPOTIFY_MCP_TOOLSETS = 'playback';
    await tokenFile(without('user-modify-playback-state', 'playlist-modify-public', 'playlist-modify-private', 'user-library-modify'));
    const report = await harness()();

    assert.ok(!report.surface.active_modules.includes('library'), 'precondition: library is not active');
    assert.equal(report.scopeRow.status, 'warn', `expected the playback gap, got: ${report.text}`);
    assert.match(report.scopeRow.detail ?? '', /user-modify-playback-state/);
    assert.doesNotMatch(report.scopeRow.detail ?? '', /user-library-modify|playlist-modify/);
  });
});

describe('#681 — ugc-image-upload is covered', () => {
  it('warns and names the tool when the grant lacks ugc-image-upload', async () => {
    await tokenFile(without('ugc-image-upload'));
    const report = await harness()();

    assert.equal(report.scopeRow.status, 'warn', `expected a warn, got: ${report.text}`);
    assert.match(report.text, /ugc-image-upload/, 'the missing scope must be named');
    assert.match(report.text, /upload_playlist_cover/, 'and the tool that will 403');
  });

  it('does not warn when ugc-image-upload is granted', async () => {
    await tokenFile(DEFAULT_SCOPES.join(' '));
    const report = await harness()();
    assert.equal(report.scopeRow.status, 'pass', `the default grant leaves no gap: ${report.text}`);
  });

  it('is silenced by an override that unregisters the playlists module', async () => {
    process.env.SPOTIFY_MCP_DISABLE_TOOLS = 'playlists';
    await tokenFile(without('ugc-image-upload'));
    const report = await harness()();

    assert.doesNotMatch(
      report.scopeRow.detail ?? '',
      /ugc-image-upload/,
      `asks for ugc-image-upload for an unregistered module: ${report.text}`,
    );
  });

  it('is not reported as a second gap when no playlist-modify scope is granted at all', async () => {
    // The cover upload cannot be reached without a modify scope, so naming
    // `ugc-image-upload` on top of the modify gap would be noise about a tool
    // that fails on the modify scope first.
    await tokenFile(without('playlist-modify-public', 'playlist-modify-private', 'ugc-image-upload'));
    const report = await harness()();

    const detail = report.scopeRow.detail ?? '';
    assert.match(detail, /playlist-modify/, 'the precondition gap is the one to report');
    assert.doesNotMatch(detail, /upload_playlist_cover/);
  });
});

describe('#681 — either-of scope groups are not reported as all-of', () => {
  it('a public-only playlist grant is a working grant, not a gap', async () => {
    // `scopefilter.ts` keeps the module registered on either modify scope, so
    // demanding both would send the caller to re-auth for nothing.
    await tokenFile(without('playlist-modify-private'));
    const report = await harness()();
    assert.doesNotMatch(
      report.scopeRow.detail ?? '',
      /playlist-modify-private/,
      `reported a satisfied either-of group as a gap: ${report.text}`,
    );
  });
});

describe('#681 — SPOTIFY_MCP_READONLY', () => {
  it('emits one explicit info row and no write-scope warning', async () => {
    process.env.SPOTIFY_MCP_READONLY = '1';
    await tokenFile('user-read-private');
    const report = await harness()();

    const scopeRows = report.rows.filter((r) => r.id === 'scopes');
    assert.equal(scopeRows.length, 1, 'exactly one scopes row');
    assert.equal(scopeRows[0].status, 'info', `READONLY must not claim a verdict: ${scopeRows[0].summary}`);
    assert.match(scopeRows[0].summary, /readonly/i);
    assert.ok(report.surface.read_only, 'precondition: the surface really is in readonly mode');
    assert.ok(
      report.surface.hidden_by_readonly.length > 0,
      'precondition: READONLY really did hide write modules',
    );
  });

  it('a readonly session names no write scope as missing anywhere in the row', async () => {
    process.env.SPOTIFY_MCP_READONLY = '1';
    await tokenFile(without('user-modify-playback-state', 'user-library-modify', 'ugc-image-upload'));
    const report = await harness()();

    assert.equal(report.scopeRow.status, 'info');
    assert.doesNotMatch(report.text, /user-modify-playback-state|user-library-modify|ugc-image-upload/);
  });
});
