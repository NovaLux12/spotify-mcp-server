/**
 * Registry-level contract for the env switches that decide which tools a
 * server serves (#661).
 *
 * `SPOTIFY_MCP_READONLY`, `SPOTIFY_MCP_TOOLSETS`, `SPOTIFY_MCP_ENABLE_TOOLS`
 * and `SPOTIFY_MCP_DISABLE_TOOLS` are all consumed in one place — `src/index.ts`
 * builds a `RegistrarManifestContext` and `moduleRegistrationStatus` decides
 * per module whether it registers, trims, scope-filters or hides. Everything
 * the user can observe flows through `tools/list`. The unit suites around
 * those predicates can all stay green while the wiring that feeds them is
 * wrong (a context built with `readOnly: false`, a resolver result thrown away,
 * a `readOnlySafe` flag read from the wrong field), so this file spawns the
 * real server and reads `tools/list`, `prompts/list` and `resources/list` back
 * off the wire.
 *
 * **Why the expectations are derived rather than typed.** A hand-written list
 * of "the tools READONLY must hide" is a second registry: it goes stale the
 * day a module is added, and it is exactly the shape that makes a test pass
 * after the thing it guards has rotted. So the expected surface is computed
 * from `REGISTRAR_MANIFEST` — the same single list `src/index.ts` walks — by
 * asking the manifest which rows are `readOnlySafe` and which registration
 * keys are active, and unioning the tools those rows register. The derivation
 * registers the whole manifest once in-process to learn which tools each row
 * owns, then drops the in-process server; every assertion after that is
 * against a spawned process.
 *
 * The derivation is not a tautology. It answers a *different* question from
 * the one the server answers: "given these manifest flags, which rows should
 * contribute tools?" versus "given this environment, which tools does the
 * server actually serve?". `moduleRegistrationStatus` is not imported here, so
 * removing the read-only branch or the toolset branch from it moves the spawned
 * surface and leaves the expectation where it was. Each case additionally
 * asserts a hand-named present set and absent set, so even a change that
 * somehow moved both sides together would have to move a named tool.
 *
 * Spawn hygiene: every child gets a fresh `mkdtemp` home under the suite's
 * disposable `HERMETIC_ROOT` and an explicit token-file path inside it, and
 * the whole `SPOTIFY_*` family is stripped from the inherited environment first
 * so a developer's shell cannot leak a real token or a real toolset into a
 * case. Stdio only — no server in this file binds a port, so nothing here can
 * contend for the default OAuth redirect on 127.0.0.1:8888.
 *
 * Run: node --import tsx --test tests/env-switch-registry.test.ts
 */
import './helpers/hermetic.js';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  REGISTRAR_MANIFEST,
  moduleToolNames,
  registerManifestModules,
} from '../src/tools/annotations.js';
import {
  isModuleActive,
  resolveToolOverrides,
  resolveToolsets,
} from '../src/toolsets.js';
import { SpotifyClient } from '../src/client.js';
import { HERMETIC_ROOT } from './helpers/hermetic.js';

const REPO_ROOT = join(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
// Manifest-derived expectations
// ---------------------------------------------------------------------------

interface ManifestRow {
  key: string;
  registrationKey: string;
  alwaysActive: boolean;
  readOnlySafe: boolean;
  tools: readonly string[];
}

let ROWS: readonly ManifestRow[] = [];

before(async () => {
  // One in-process registration pass, purely to learn which tools each manifest
  // row owns. `isModuleActive: () => true` and `scopeBlocked: () => false`
  // mirror the spawned baseline: no toolset spec, and no granted scopes (an
  // absent token file resolves to an empty granted set, which the scope filter
  // fails open on — `moduleBlockedByScopes`).
  const server = new McpServer({ name: 'env-switch-derivation', version: '0.0.0' });
  await registerManifestModules(server, new SpotifyClient(), {
    readOnly: false,
    isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  ROWS = REGISTRAR_MANIFEST.map((entry) => ({
    key: entry.key,
    registrationKey: entry.registrationKey,
    alwaysActive: entry.alwaysActive === true,
    readOnlySafe: entry.readOnlySafe === true,
    tools: moduleToolNames(server, entry.key),
  }));
});

interface Switches {
  readOnly?: boolean;
  toolsets?: string;
  enable?: string;
  disable?: string;
}

/**
 * The tool names a server with these switches should serve, computed from the
 * manifest alone. Mirrors `isModuleActive`'s precedence (disable beats enable
 * beats set membership) and the row-level read-only gate: a row is hidden
 * unless it declares `readOnlySafe: true`.
 */
function expectedToolNames(switches: Switches): Set<string> {
  const { sets } = resolveToolsets(switches.toolsets);
  const { enable, disable } = resolveToolOverrides(switches.enable, switches.disable);
  const names = new Set<string>();
  for (const row of ROWS) {
    if (!row.alwaysActive && !isModuleActive(row.registrationKey, sets, { enable, disable })) continue;
    if (switches.readOnly === true && !row.readOnlySafe) continue;
    for (const name of row.tools) names.add(name);
  }
  return names;
}

/** Tool names the always-active rows contribute, whatever else is trimmed. */
function alwaysActiveToolNames(readOnly: boolean): Set<string> {
  return ROWS
    .filter((r) => r.alwaysActive && (!readOnly || r.readOnlySafe))
    .flatMap((r) => [...r.tools])
    .reduce<Set<string>>((acc, name) => acc.add(name), new Set());
}

/** Both directions of a set comparison, so a failure names the tools. */
function surfaceDiff(expected: ReadonlySet<string>, actual: ReadonlySet<string>) {
  return {
    missing: [...expected].filter((n) => !actual.has(n)).sort(),
    unexpected: [...actual].filter((n) => !expected.has(n)).sort(),
  };
}

function reportDiff(label: string, diff: { missing: string[]; unexpected: string[] }): string {
  const lines = [`${label}: expected ${diff.missing.length} missing + ${diff.unexpected.length} unexpected`];
  if (diff.missing.length) lines.push(`  missing from tools/list: ${diff.missing.join(', ')}`);
  if (diff.unexpected.length) lines.push(`  served but should not be: ${diff.unexpected.join(', ')}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Spawn harness
// ---------------------------------------------------------------------------

interface SpawnedSurface {
  tools: string[];
  prompts: string[];
  resources: string[];
  resourceTemplates: string[];
  capabilities: Record<string, unknown>;
  stderr: string;
}

/**
 * The environment a child starts from, minus every `SPOTIFY_*` variable the
 * developer's shell happens to carry. Without this strip, a case's result
 * depends on whether the person running it exported `SPOTIFY_MCP_READONLY`
 * or `SPOTIFY_MCP_TOOLSETS` — the failure would then look like a product bug
 * in whatever machine happened to fail.
 */
function baseChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Strip every SPOTIFY_* inherited variable. Setting one to '' is not the same
  // as unsetting it — since #617 a set-but-empty `SPOTIFY_SCOPES` is a startup
  // error — so these are deleted, not blanked.
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPOTIFY_')) delete env[key];
  }
  return env;
}

const spawnCache = new Map<string, Promise<SpawnedSurface>>();

/** Raw JSON-RPC, so a `-32601` (method not advertised) is observable, not swallowed. */
interface JsonRpc {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function runSurface(env: Record<string, string | undefined>): Promise<SpawnedSurface> {
  const cacheKey = JSON.stringify(env, Object.keys(env).sort());
  const cached = spawnCache.get(cacheKey);
  if (cached) return cached;
  const promise = spawnSurface(env);
  spawnCache.set(cacheKey, promise);
  return promise;
}

async function spawnSurface(env: Record<string, string | undefined>): Promise<SpawnedSurface> {
  const home = mkdtempSync(join(HERMETIC_ROOT, 'env-switch-'));
  const base = { ...baseChildEnv(), HOME: home, USERPROFILE: home };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  // Always explicit, always inside the disposable home: the child must never
  // be able to reach the developer's real ~/.spotify-mcp/tokens.json.
  base.SPOTIFY_CLIENT_ID = 'env-switch-test';
  base.SPOTIFY_MCP_TOKEN_FILE = join(home, 'tokens.json');

  const child = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: base,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const pending = new Map<number, (v: JsonRpc) => void>();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpc;
      if (typeof msg.id !== 'number') continue;
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });

  let id = 0;
  const request = (method: string, params: Record<string, unknown> = {}): Promise<JsonRpc> => {
    const { promise, resolve, reject } = Promise.withResolvers<JsonRpc>();
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: myId, method, params })}\n`);
    // Watchdog only. The server is a separate OS process whose timers cannot be
    // faked from here, so a real deadline is the only way to fail fast instead
    // of hanging the run. The wait itself is event-driven.
    setTimeout(
      () => reject(new Error(`timeout waiting for ${method}\nstderr:\n${stderr}`)),
      30_000,
    ).unref();
    return promise;
  };

  const namesOf = (result: JsonRpc, key: string, field: 'name' | 'uri'): string[] => {
    const value = result.result?.[key];
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => (entry as Record<string, unknown>)[field])
      .filter((v): v is string => typeof v === 'string')
      .sort();
  };

  try {
    const init = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'env-switch-test', version: '1.0.0' },
    });
    assert.equal(init.error, undefined, `initialize failed: ${JSON.stringify(init.error)}\nstderr:\n${stderr}`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);

    const listed = await request('tools/list');
    assert.equal(listed.error, undefined, `tools/list failed: ${JSON.stringify(listed.error)}`);
    const tools = listed.result?.tools;
    assert.ok(Array.isArray(tools) && tools.length > 0, 'tools/list must return a non-empty array');

    const surface: SpawnedSurface = {
      tools: tools.map((t) => (t as Record<string, unknown>).name as string).sort(),
      prompts: [],
      resources: [],
      resourceTemplates: [],
      capabilities: (init.result?.capabilities ?? {}) as Record<string, unknown>,
      stderr: '',
    };
    // Resources and prompts are gated outside the manifest, in src/index.ts, so
    // they need their own read. A trimmed server does not advertise the
    // capability at all and answers -32601 rather than an empty list; an empty
    // array here therefore means "advertised, and empty", which is a different
    // claim from "not served" and is checked through `capabilities` instead.
    const prompts = await request('prompts/list');
    surface.prompts = prompts.error ? [] : namesOf(prompts, 'prompts', 'name');
    const resources = await request('resources/list');
    surface.resources = resources.error ? [] : namesOf(resources, 'resources', 'uri');
    const templates = await request('resources/templates/list');
    // Templates carry `uriTemplate`, not `uri` — reading the wrong field yields
    // an empty array that looks exactly like "no templates registered".
    surface.resourceTemplates = templates.error ? [] : namesOf(templates, 'resourceTemplates', 'uriTemplate');
    surface.stderr = stderr;
    return surface;
  } finally {
    child.stdin.end();
    setTimeout(() => child.kill('SIGKILL'), 1500).unref();
  }
}

/** Run a server that is expected to refuse to start, and capture why. */
async function runExpectingStartupFailure(env: Record<string, string | undefined>) {
  const home = mkdtempSync(join(HERMETIC_ROOT, 'env-switch-fail-'));
  const base = { ...baseChildEnv(), HOME: home, USERPROFILE: home };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  base.SPOTIFY_CLIENT_ID = 'env-switch-test';
  base.SPOTIFY_MCP_TOKEN_FILE = join(home, 'tokens.json');

  const child = spawn('node', ['--import', 'tsx/esm', 'src/index.ts'], {
    cwd: REPO_ROOT,
    env: base,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.end();
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stderr };
}

after(() => {
  spawnCache.clear();
});

// ---------------------------------------------------------------------------
// Named anchors
//
// Small hand-written lists, deliberately NOT derived. They exist so that a
// change which moved the derivation and the server together would still have to
// move one of these names to pass.
// ---------------------------------------------------------------------------

/** Readers and discovery tools that must survive `SPOTIFY_MCP_READONLY`. */
const READONLY_MUST_SERVE = [
  'get_me',
  'search',
  'search_deep',
  'get_track',
  'get_album_tracks',
  'get_top_artists',
  'library_coverage_report',
  'spotify_doctor',
  'find_tool',
  'verify_receipt',
  'backup_library',
  'list_backups',
  'statsfm_top_artists',
  'whats_new',
] as const;

/**
 * Writers that must be hidden by `SPOTIFY_MCP_READONLY`. The `*_plan` and
 * `*_preview` names are here deliberately: a suffix proves nothing, and most
 * plan tools accept a commit path, so they are writers until a handler has been
 * verified and the name added to `NEVER_MUTATING_PLANS`. Their rows do not
 * claim `readOnlySafe`, so the gate hides them — this list is what would catch
 * that changing.
 */
const READONLY_MUST_HIDE = [
  'play',
  'pause',
  'play_from_search',
  'add_to_playlist',
  'save_to_library',
  'remove_from_library',
  'queue_playlist',
  'batch_add_to_playlist',
  'undo_mutation',
  'undo_preview',
  'delete_backup',
  'restore_library_snapshot',
  'follow_playlist',
  'unfollow_playlist',
  'pin_playlist',
  'taste_to_playlist',
  'apply_scene',
  'create_smart_playlist',
  'import_playlist',
  'snapshot_playlist',
  'plan_podcast_session',
  'show_backlog_plan',
  'sort_playlist_plan',
  'sort_playlist_apply',
  'merge_playlists_plan',
  'save_artist_new_releases',
  'quick_save_now',
] as const;

// ---------------------------------------------------------------------------
// The switch matrix
// ---------------------------------------------------------------------------

describe('env switches at the registry (#661)', () => {
  describe('baseline', () => {
    it('serves every manifest tool when no switch is set', async () => {
      const surface = await runSurface({});
      const expected = expectedToolNames({});
      const diff = surfaceDiff(expected, new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('default surface', diff));
      assert.equal(diff.missing.length, 0, reportDiff('default surface', diff));
      // If the derivation produced nothing the comparison above would be
      // trivially true, so the floor is stated rather than assumed.
      assert.ok(expected.size > 0, 'the manifest-derived surface must not be empty');
    });

    it('claims each tool for exactly one manifest row', () => {
      const owner = new Map<string, string>();
      const collisions: string[] = [];
      for (const row of ROWS) {
        for (const name of row.tools) {
          const previous = owner.get(name);
          if (previous !== undefined) collisions.push(`${name} (${previous} + ${row.key})`);
          else owner.set(name, row.key);
        }
      }
      assert.deepEqual(collisions, [], `tools registered by more than one row: ${collisions.join(', ')}`);
    });
  });

  describe('SPOTIFY_MCP_READONLY', () => {
    it('serves exactly the readOnlySafe rows and nothing else', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_READONLY: '1' });
      const expected = expectedToolNames({ readOnly: true });
      const diff = surfaceDiff(expected, new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('read-only surface', diff));
      assert.equal(diff.missing.length, 0, reportDiff('read-only surface', diff));
      // Both halves must be non-empty for the comparison above to mean
      // anything: a server serving every tool and a server serving none would
      // both be caught here, but an empty derivation would not.
      assert.ok(expected.size > 0, 'read-only derivation must not be empty');
      assert.ok(
        expected.size < expectedToolNames({}).size,
        'the read-only surface must be a strict subset of the full surface, or the gate hid nothing',
      );
    });

    it('hides every write tool, by name, and keeps the read tools', async () => {
      const surface = new Set((await runSurface({ SPOTIFY_MCP_READONLY: '1' })).tools);
      for (const name of READONLY_MUST_HIDE) {
        assert.equal(surface.has(name), false, `write tool "${name}" must not be served when SPOTIFY_MCP_READONLY is set`);
      }
      for (const name of READONLY_MUST_SERVE) {
        assert.equal(surface.has(name), true, `read tool "${name}" must still be served when SPOTIFY_MCP_READONLY is set`);
      }
    });

    it('hides every tool owned by a row that does not declare readOnlySafe', () => {
      // Row-level contract, independent of any spawn. If a future row is added
      // without `readOnlySafe: true` its tools are writes until proven
      // otherwise, so this is the property the spawned assertion relies on.
      const hidden = ROWS.filter((r) => !r.readOnlySafe).flatMap((r) => r.tools);
      assert.ok(hidden.length > 0, 'the manifest must contain non-read-only rows');
      for (const name of hidden) {
        assert.equal(
          [...ROWS].filter((r) => r.readOnlySafe).some((r) => r.tools.includes(name)),
          false,
          `"${name}" is claimed by a read-only row, so it would survive the gate`,
        );
      }
    });

    it('hides a read tool that shares a row with a writer', async () => {
      // The gate is per manifest row, not per tool, and that is the intended
      // shape: `get_saved_tracks` reads and `save_to_library` writes both live
      // in the `library` row, and the row cannot claim `readOnlySafe` while the
      // writer is in it. So a read-only session loses the reader too. Stating
      // this here means the row-granularity is a decision someone made rather
      // than a surprise, and that splitting the row to keep the reader would
      // have to move both names deliberately.
      const readOnly = new Set((await runSurface({ SPOTIFY_MCP_READONLY: '1' })).tools);
      const baseline = new Set((await runSurface({})).tools);
      assert.ok(baseline.has('get_saved_tracks'), 'the default surface must serve get_saved_tracks');
      assert.equal(
        readOnly.has('get_saved_tracks'),
        false,
        'a read tool sharing a row with a writer is hidden by the row-level gate',
      );
      // The escape hatch is a tool override, not a rename: the same reader is
      // still reachable through a read-only row.
      assert.ok(readOnly.has('library_coverage_report'), 'library reads in their own read-only row survive');
    });

    it('treats every documented truthy spelling as on and everything else as off', async () => {
      // `readOnlyModeEnabled()` parses the value; a spawn proves the parse
      // reaches the registry rather than stopping at the config module.
      const full = expectedToolNames({}).size;
      const readOnly = expectedToolNames({ readOnly: true }).size;
      const on: string[] = ['1', 'true', 'on', 'YES', '  yes  '];
      const off: string[] = ['0', 'false', 'off', 'banana', ''];
      for (const value of on) {
        const surface = await runSurface({ SPOTIFY_MCP_READONLY: value });
        assert.equal(surface.tools.length, readOnly, `SPOTIFY_MCP_READONLY=${JSON.stringify(value)} should be on; got ${surface.tools.length} tools`);
      }
      for (const value of off) {
        const surface = await runSurface({ SPOTIFY_MCP_READONLY: value });
        assert.equal(surface.tools.length, full, `SPOTIFY_MCP_READONLY=${JSON.stringify(value)} should be off; got ${surface.tools.length} tools`);
      }
    });

    it('leaves resources and prompts to their own gates', async () => {
      // The read-only switch is a tool gate. Resources and prompts are gated in
      // src/index.ts, not in the manifest, and docs/configuration.md says they
      // remain available when their own gates permit. Both directions are
      // asserted by name-set equality, not by a count.
      const baseline = await runSurface({});
      const readOnly = await runSurface({ SPOTIFY_MCP_READONLY: '1' });
      assert.ok(baseline.prompts.length > 0, 'the baseline server must serve prompts, or this proves nothing');
      assert.ok(baseline.resources.length > 0, 'the baseline server must serve resources, or this proves nothing');
      assert.deepEqual(readOnly.prompts, baseline.prompts, 'SPOTIFY_MCP_READONLY changed the prompt surface');
      assert.deepEqual(readOnly.resources, baseline.resources, 'SPOTIFY_MCP_READONLY changed the resource surface');
      assert.deepEqual(readOnly.resourceTemplates, baseline.resourceTemplates, 'SPOTIFY_MCP_READONLY changed the resource-template surface');
    });

    it('narrows a trimmed surface further', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_READONLY: '1', SPOTIFY_MCP_TOOLSETS: 'playback' });
      const expected = alwaysActiveToolNames(true);
      const diff = surfaceDiff(expected, new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('read-only + playback', diff));
      assert.equal(diff.missing.length, 0, reportDiff('read-only + playback', diff));
      // The intersection is the always-active rows that are also read-only:
      // doctor, swarm3meta and receipts. Anything wider means one of the two
      // gates stopped applying.
      for (const name of ['spotify_doctor', 'find_tool', 'inspect_tool', 'toolset_report', 'verify_receipt']) {
        assert.ok(surface.tools.includes(name), `"${name}" is always active and read-only, so it must survive both gates`);
      }
      for (const name of ['play', 'pause', 'queue_playlist', 'play_on', 'search', 'get_album_tracks']) {
        assert.equal(surface.tools.includes(name), false, `"${name}" must not survive read-only + a playback-only toolset`);
      }
    });
  });

  describe('SPOTIFY_MCP_TOOLSETS', () => {
    it('trims to the named set', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'playback' });
      const expected = expectedToolNames({ toolsets: 'playback' });
      const diff = surfaceDiff(expected, new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('playback toolset', diff));
      assert.equal(diff.missing.length, 0, reportDiff('playback toolset', diff));
      for (const name of ['play', 'pause', 'queue_playlist', 'describe_queue', 'save_playback_state']) {
        assert.ok(surface.tools.includes(name), `playback tool "${name}" should be served by the playback toolset`);
      }
      for (const name of ['search', 'get_album_tracks', 'get_playlist', 'add_to_playlist', 'get_saved_tracks', 'statsfm_top_artists']) {
        assert.equal(surface.tools.includes(name), false, `"${name}" is outside the playback toolset and must be trimmed`);
      }
    });

    it('trims to the core set', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'core' });
      const diff = surfaceDiff(expectedToolNames({ toolsets: 'core' }), new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('core toolset', diff));
      assert.equal(diff.missing.length, 0, reportDiff('core toolset', diff));
      assert.ok(surface.tools.includes('search'), 'core covers search');
      assert.equal(surface.tools.includes('get_artist_genres'), false, 'core does not include the browse set');
    });

    it('keeps the always-active rows no matter how narrow the set', async () => {
      // `playbackintel` is the narrowest set that still exercises the carve-out:
      // it does not list `swarm3meta`, so the three discovery tools can only be
      // present through `alwaysActive`. A set that happened to include them
      // (`discovery`, `core`) would pass with the flag removed, which is exactly
      // the kind of assertion that proves nothing.
      const surface = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'playbackintel' });
      for (const name of ['spotify_doctor', 'find_tool', 'inspect_tool', 'toolset_report', 'verify_receipt']) {
        assert.ok(surface.tools.includes(name), `"${name}" is always active and must survive a playbackintel-only toolset`);
      }
      assert.ok(surface.tools.includes('describe_queue'), 'playbackintel is the selected set, so its tools register');
      assert.equal(surface.tools.includes('play'), false, 'the playback set is not enabled here');
      assert.equal(surface.tools.includes('get_playlist'), false, 'the playlists set is not enabled here');
    });

    it('withdraws the prompts and resources capabilities when their sets are off', async () => {
      const trimmed = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'playback' });
      assert.equal('prompts' in trimmed.capabilities, false, 'a server with the prompts set off must not advertise prompts');
      assert.equal('resources' in trimmed.capabilities, false, 'a server with the resources set off must not advertise resources');

      const kept = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'resources,prompts' });
      assert.ok(kept.prompts.length > 0, 'the prompts set must serve prompts');
      assert.ok(kept.resources.length > 0, 'the resources set must serve resources');
      assert.ok(kept.resourceTemplates.length > 0, 'the resources set must serve resource templates');
    });

    it('ignores an unknown set name but still serves the known ones', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'playback,bogus' });
      const diff = surfaceDiff(expectedToolNames({ toolsets: 'playback' }), new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('playback,bogus toolset', diff));
      assert.equal(diff.missing.length, 0, reportDiff('playback,bogus toolset', diff));
      assert.ok(surface.tools.includes('play'), 'a known set in a mixed spec must still register');
      assert.match(surface.stderr, /bogus/, 'the unknown set name must be reported on stderr');
    });

    it('refuses to start when every named set is unknown', async () => {
      const { code, stderr } = await runExpectingStartupFailure({ SPOTIFY_MCP_TOOLSETS: 'nope' });
      assert.notEqual(code, 0, 'an unknown-only toolset spec must fail startup rather than serve an empty registry');
      assert.match(stderr, /nope/, 'the failing startup must name the unknown set');
      assert.match(stderr, /playback/, 'the failing startup must list the sets that would have worked');
    });
  });

  describe('SPOTIFY_MCP_ENABLE_TOOLS / SPOTIFY_MCP_DISABLE_TOOLS', () => {
    it('disables one registration key and leaves its neighbours alone', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_DISABLE_TOOLS: 'playback' });
      const diff = surfaceDiff(expectedToolNames({ disable: 'playback' }), new Set(surface.tools));
      assert.equal(diff.unexpected.length, 0, reportDiff('playback disabled', diff));
      assert.equal(diff.missing.length, 0, reportDiff('playback disabled', diff));
      for (const name of ['play', 'pause', 'get_now_playing', 'play_from_search']) {
        assert.equal(surface.tools.includes(name), false, `"${name}" is a playback tool and must be disabled`);
      }
      // `queueops` is a separate registration key, so the discriminating
      // neighbour survives — this is what separates a key-level disable from
      // "turn playback off" and from a broken filter that hides everything.
      for (const name of ['queue_playlist', 'describe_queue', 'play_on']) {
        assert.ok(surface.tools.includes(name), `"${name}" is not in the playback key and must survive disabling it`);
      }
      assert.ok(surface.tools.includes('search'), 'disabling one key must not disturb the rest of the surface');
    });

    it('re-enables a key a trimmed toolset left out', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_TOOLSETS: 'playback', SPOTIFY_MCP_ENABLE_TOOLS: 'statsfm' });
      const diff = surfaceDiff(
        expectedToolNames({ toolsets: 'playback', enable: 'statsfm' }),
        new Set(surface.tools),
      );
      assert.equal(diff.unexpected.length, 0, reportDiff('playback + statsfm enabled', diff));
      assert.equal(diff.missing.length, 0, reportDiff('playback + statsfm enabled', diff));
      assert.ok(surface.tools.includes('statsfm_top_artists'), 'an explicitly enabled key must register');
      assert.equal(surface.tools.includes('get_album_tracks'), false, 'enabling one key must not enable the catalog set');
      assert.equal(surface.tools.includes('play'), true, 'the trimmed-but-selected playback set must still be active');
    });

    it('lets disable win over enable', async () => {
      const surface = await runSurface({ SPOTIFY_MCP_ENABLE_TOOLS: 'playback', SPOTIFY_MCP_DISABLE_TOOLS: 'playback' });
      const diff = surfaceDiff(
        expectedToolNames({ enable: 'playback', disable: 'playback' }),
        new Set(surface.tools),
      );
      assert.equal(diff.unexpected.length, 0, reportDiff('enable+disable playback', diff));
      assert.equal(diff.missing.length, 0, reportDiff('enable+disable playback', diff));
      assert.equal(surface.tools.includes('play'), false, 'disable must beat enable');
    });
  });

  describe('the comparison itself', () => {
    it('reports a hidden-nothing filter as a failure', () => {
      // The shape this guards against is a test that only compares sizes: a
      // read-only filter that hid nothing would still leave the surface smaller
      // than nothing, and a `size < size` assertion would pass. Drive the
      // comparator with a server that ignored the switch and confirm it names
      // the tools that leaked rather than just disagreeing about a number.
      const leaked = new Set(expectedToolNames({}));
      const diff = surfaceDiff(expectedToolNames({ readOnly: true }), leaked);
      assert.ok(diff.unexpected.includes('play'), 'the diff must name a specific leaked write tool');
      assert.ok(diff.unexpected.includes('add_to_playlist'), 'the diff must name a specific leaked write tool');
      assert.ok(diff.unexpected.length > 0, 'a filter that hid nothing must produce unexpected names');
    });

    it('reports a filter that hid too much as a failure', () => {
      const overTrimmed = new Set(expectedToolNames({ readOnly: true }).values());
      overTrimmed.delete('search');
      const diff = surfaceDiff(expectedToolNames({ readOnly: true }), overTrimmed);
      assert.deepEqual(diff.missing, ['search']);
      assert.deepEqual(diff.unexpected, []);
    });
  });
});
