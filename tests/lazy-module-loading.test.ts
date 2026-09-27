/**
 * Lazy tool-module loading behind the toolset gate (#906).
 *
 * Before this, `src/tools/annotations.ts` statically imported all 66 tool
 * modules in order to name their registrars in the manifest. Evaluation
 * therefore happened before the toolset gate could answer, and trimming the
 * surface shrank the payload without shrinking startup: the issue measured
 * 383 ms with 608 tools against 269 ms with 103, and an identical RSS floor.
 *
 * The manifest now holds a specifier string and a thunk, and
 * `registerManifestModules` imports only the modules that are about to
 * register. Two things have to stay true, and each gets its own proof:
 *
 *   1. LAZINESS IS REAL. Asserted through the module system itself — an ESM
 *      `resolve` hook records every module the process loads, so the test sees
 *      `./tools/playlists.ts` being evaluated or not, regardless of what our
 *      own bookkeeping claims. A spy wrapped around `module.load` would not do:
 *      it asserts our code called our own thunk, and would stay green if a
 *      static import reintroduced the cost somewhere else.
 *
 *   2. THE BUDGET GATE IS STILL A STARTUP TRIPWIRE. Laziness changes WHEN a
 *      module is evaluated, never WHETHER a module that serves tools is
 *      measured. `startMcpServer` still runs the naming policy, the per-module
 *      schema budget gate, annotation application, the error boundary and the
 *      aggregate gate, in that order, against the same live registry — and the
 *      tests below drive those same exported functions over a lazily-built
 *      server and require them to still throw.
 *
 * On the thresholds in the issue (< 180 ms, < 110 MB with
 * `SPOTIFY_MCP_TOOLSETS=playback`): those are absolute figures from the
 * reporter's machine and are not asserted here. Measured on the host this
 * landed on, the PRE-change baseline for that toolset was ~246 ms — the
 * thresholds were never reachable here, before or after — and on a shared host
 * the same A/B re-run minutes later moves by 5× with load, so a test that
 * encodes another machine's milliseconds goes red for reasons that have nothing
 * to do with this change. What is asserted instead is the machine-independent
 * fact those thresholds were a proxy for: how many tool modules the process
 * evaluates. Measured on both dists of the same tree, that is 18 under
 * `playback` where it was 69, for the identical 106 tools.
 * `scripts/measure-startup.mjs` is the harness for the wall-clock and RSS
 * numbers; ARCHITECTURE.md records the interleaved A/B, including the part
 * that does not flatter the change (peak RSS rises under a trimmed toolset,
 * and the millisecond figures are one sample on a loaded host, not a promise).
 *
 * Run: node --import tsx --test tests/lazy-module-loading.test.ts
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SpotifyClient } from '../src/client.js';
import { resolveToolsets, isModuleActive } from '../src/toolsets.js';
import {
  AGGREGATE_SURFACE_LIMITS,
  REGISTRAR_MANIFEST,
  assertAggregateSurfaceBudget,
  assertModuleSchemaBudgets,
  collectAggregateSurfaceMeasurement,
  collectModuleSchemaBudgets,
  lazyModule,
  localModule,
  loadManifestRegistrars,
  manifestEntry,
  registerManifestModule,
  registerManifestModules,
  type RegistrarManifestContext,
} from '../src/tools/annotations.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECORDER = join(REPO_ROOT, 'tests/fixtures/record-module-loads.mjs');

/** Every module active: the default install, and the census's own context. */
const ALL_ACTIVE: RegistrarManifestContext = {
  readOnly: false,
  isModuleActive: () => true,
  scopeBlocked: () => false,
};

function contextForToolsets(spec: string): RegistrarManifestContext {
  const { sets } = resolveToolsets(spec);
  return {
    readOnly: false,
    isModuleActive: (key) => isModuleActive(key, sets),
    scopeBlocked: () => false,
  };
}

/** Tool modules a `playback` install must not touch, by file basename. */
const UNRELATED_TO_PLAYBACK = [
  'playlists', 'playlistops', 'playlistbatch', 'playlistmisc', 'playlistfollow',
  'playlisthealth', 'playlistdna', 'library', 'libraryinsights', 'libraryanalytics',
  'libraryhygiene', 'portability', 'swarm4_playlists', 'exhaust2_playlists',
  'exhaust2_catalog', 'exhaust2_misc', 'swarm3_library', 'swarm3_playlistops',
  'swarm3_snapshots', 'swarm3_discovery', 'swarm3b_discovery', 'swarm3_shows',
  'swarm3_analytics', 'swarm3_refs', 'statsfm', 'taste_composites',
  'following', 'freshness', 'artistwatch', 'browse', 'users', 'audiobooks',
];

interface RecordedRun {
  toolCount: number;
  toolModules: string[];
}

/**
 * Start the real entry over stdio with the load recorder installed, read
 * `tools/list`, and report the tool count plus every `src/tools/*` file the
 * process actually evaluated.
 */
function recordStartup(toolsets: string): Promise<RecordedRun> {
  const home = mkdtempSync(join(tmpdir(), 'w906-lazy-'));
  const record = join(home, 'modules.txt');
  const tokenFile = join(home, 'tokens.json');
  writeFileSync(tokenFile, JSON.stringify({
    access_token: 'lazy-test',
    refresh_token: 'lazy-test',
    expires_at: Date.now() + 60 * 60 * 1000,
  }));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm',
      '--import', RECORDER,
      join(REPO_ROOT, 'src/index.ts'),
    ], {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        SPOTIFY_CLIENT_ID: 'lazy-test',
        SPOTIFY_MCP_TOKEN_FILE: tokenFile,
        SPOTIFY_MCP_MODULE_LOAD_RECORD: record,
        SPOTIFY_MCP_TOOLSETS: toolsets,
        SPOTIFY_MCP_CONFIRM: 'never',
      },
    });

    let out = '';
    let err = '';
    let settled = false;
    // The record file is the whole point of the run, so read it before the
    // temp home is removed and before the child is reaped.
    const finish = (settle: (run: RecordedRun) => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      const toolModules = existsSync(record)
        ? [...new Set(readFileSync(record, 'utf8')
          .split('\n')
          .map((url) => /\/src\/tools\/([\w.-]+)\.(?:ts|js)$/.exec(url)?.[1] ?? '')
          .filter(Boolean))]
        : [];
      rmSync(home, { recursive: true, force: true });
      settle({ toolCount, toolModules });
    };

    let toolCount = 0;
    const timer = setTimeout(
      () => finish(() => reject(new Error(`TOOLSETS=${toolsets} never answered tools/list\n${err}`))),
      60_000,
    );

    child.stderr.on('data', (chunk) => { err += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      let boundary;
      while ((boundary = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, boundary);
        out = out.slice(boundary + 1);
        if (!line.trim()) continue;
        let message: { id?: number; result?: { tools?: unknown[] } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && Array.isArray(message.result?.tools)) {
          toolCount = message.result.tools.length;
          finish(resolve);
          return;
        }
      }
    });
    child.on('error', (error) => finish(() => reject(error)));
    // A child that dies before answering must say so (#1404).
    //
    // There was no `exit` listener at all: `on('error')` above fires on a
    // *spawn* failure only, never on a process that started and then died, so
    // a SIGKILL — the OOM killer on a box running a dozen parallel suites —
    // left nothing to reject. The 60 s watchdog caught it and reported
    // `TOOLSETS=playback never answered tools/list`, which reads as a
    // module-loading problem: a trimmed toolset failing to register. An OOM
    // mid-startup and a genuine trimming bug produce byte-identical failures,
    // and this file's whole subject is *which modules got loaded*.
    //
    // `signal` is taken as well as `code` because a signalled child has
    // `code === null`. Printing `code=null` would name "exited with no status"
    // for a kill, which is the same discarded-field mistake as #1405. A SIGKILL
    // also leaves no stderr, so `err` is empty by construction and the signal
    // is the only evidence there is.
    child.on('exit', (code, signal) => {
      if (settled) return; // `finish` killed the child itself on the success path.
      finish(() => reject(new Error(
        `TOOLSETS=${toolsets} exited before answering tools/list (code=${code} signal=${signal})\n`
        + (signal
          ? 'A signal takes the child\'s stderr with it, so an empty stderr below is expected and is itself the evidence.\n'
          : '')
        + `stderr:\n${err.trim() || '(no stderr)'}`,
      )));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) + '\n');
  });
}

describe('#906 a trimmed toolset evaluates only the modules it serves', () => {
  it('serves the same tools from a fraction of the tool modules', async () => {
    const playback = await recordStartup('playback');

    // 18 measured on the machine this landed on; 69 before the change, for the
    // identical 106-tool surface. The bound is deliberately loose so an
    // unrelated future transitive import does not redden the build, while
    // still failing loudly if the gate stops gating — a revert to static
    // imports puts every one of the 66 back.
    assert.ok(
      playback.toolModules.length <= 25,
      `TOOLSETS=playback evaluated ${playback.toolModules.length} tool modules: ${playback.toolModules.join(', ')}`,
    );
    // 106 -> 107 (#598). `expand_mood_to_queries` is `alwaysActive`, so it
    // registers under every toolset — the `prompts` set is in the default
    // install and the four mood prompts name this tool, and a prompt naming a
    // tool the surface trimmed is what `prompt-resource-hints` fails on. The
    // cost of that choice is visible right here: an `alwaysActive` module
    // lands in EVERY trimmed surface, not only the default one. Stated rather
    // than absorbed, because the next person to add a helper will hit the same
    // number and should know they will.
    assert.equal(playback.toolCount, 107, 'the playback surface itself must not change');
  });

  it('never evaluates a module whose registration key is inactive', async () => {
    const { toolModules } = await recordStartup('playback');
    for (const module of UNRELATED_TO_PLAYBACK) {
      assert.ok(
        !toolModules.includes(module),
        `src/tools/${module}.ts was evaluated under TOOLSETS=playback; the gate is not gating imports`,
      );
    }
  });

  it('evaluates every manifest module for the default install', async () => {
    const full = await recordStartup('all');
    // A tripwire, deliberately a literal: it is here to catch surface growth
    // nobody intended. #1099 grew 592 -> 594 by adding the two deprecated
    // `pin_playlist` / `unpin_playlist` aliases beside their canonical
    // replacements; #638 then took it back down by removing the eight tools
    // whose only endpoint Spotify deleted in February 2026. Writing each change
    // down rather than widening the assertion to a computed one is the point:
    // a number that moves for a stated reason is information, and one that
    // moves silently is the failure this tripwire exists to catch.
    //
    // #602 grew 587 -> 589 by adding `list_accounts` / `switch_account` —
    // the account registry's two tools, both of which the issue asked for by
    // name, and neither of which replaces an existing tool.
    //
    // #695 took the default surface 589 -> 578 by withholding eleven derived
    // listening-analytics tools unless SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is
    // set. A DELIBERATE reduction, not surface loss: the opted-in surface is
    // byte-identical to the 589 this tripwire used to pin, which
    // tests/analytics-optin-registry.test.ts asserts over a real server. A
    // silent drop from here would mean the gate took something it was not
    // supposed to take.
    //
    // Measured from the live registry on the post-rebase tree, not derived by
    // subtracting: main moved underneath this branch twice, and the removals
    // did not compose with the other changes to the plain arithmetic.
    //
    // #908 took the full surface from 589 -> 581 by dropping the eight legacy
    // `taste_*` alias registrations, each a duplicate of a canonical
    // `statsfm_*` tool with the same params and the same handler. They are not
    // in this number's arithmetic because they were never in the manifest — a
    // registration with no row of its own, which is exactly why removing them
    // could not be seen in a per-module diff and had to be measured.
    //
    // The message says "full surface", not "default surface": since #889 an
    // unset `SPOTIFY_MCP_TOOLSETS` registers a strict subset of this, so a
    // reader taking "the default surface must be unchanged" literally would be
    // asserting a number this tripwire has never measured.
    // 570 -> 571 (#598): `expand_mood_to_queries`, one `alwaysActive` read-only
    // tool. Same choice, and the same trade, as the `playback` figure above.
    assert.equal(full.toolCount, 571, 'the full (TOOLSETS=all) surface must be unchanged');
    // `annotations.ts` registers verify_receipt itself, so it is in the
    // manifest's file list without being imported through a thunk.
    const missing = REGISTRAR_MANIFEST
      .map((module) => module.file.replace(/^src\/tools\//, '').replace(/\.ts$/, ''))
      .filter((stem) => !full.toolModules.includes(stem));
    assert.deepEqual(missing, [], 'every manifest module must be evaluated under TOOLSETS=all');
  });
});

describe('#906 every manifest entry is a working thunk', () => {
  it('resolves each specifier to a callable registrar', async () => {
    // A thunk can name a specifier that does not exist; a static import could
    // not, because the compiler and the loader would both refuse it. This is
    // the check that pays for giving up that guarantee.
    for (const module of REGISTRAR_MANIFEST) {
      assert.equal(typeof module.load, 'function', `${module.key} has no loader`);
      const registrar = await module.load();
      assert.equal(typeof registrar, 'function', `${module.key} (${module.file}) did not resolve ${module.name}`);
    }
  });

  it('rejects rather than registering nothing when a module cannot be loaded', async () => {
    // The failure mode laziness introduces: a module that fails to import
    // registers no tools, and a module with no tools is exempt from its own
    // ceiling. Left unhandled, that is a silently smaller tools/list that
    // still passes every budget gate.
    const broken = manifestEntry('broken', 'broken', lazyModule('./no-such-module.js', 'nope'), [1, 100]);
    await assert.rejects(
      loadManifestRegistrars([broken], ALL_ACTIVE),
      /ERR_MODULE_NOT_FOUND|Cannot find module/,
    );
  });

  it('refuses to register a module whose registrar was never loaded', async () => {
    const server = new McpServer({ name: 'unloaded', version: '0.0.0' });
    const search = REGISTRAR_MANIFEST.find((module) => module.key === 'search');
    assert.ok(search, 'search must be in the manifest');
    assert.throws(
      () => registerManifestModule(server, new SpotifyClient(), search, ALL_ACTIVE),
      /has no loaded registrar/,
      'an unloaded module must fail loudly rather than register an empty surface',
    );
  });

  it('never hands a module a client it did not ask for', async () => {
    // Every registrar is called as `registrar(server, client)`. That is right
    // for the 62 modules taking a `SpotifyClient`, and wrong for the one that
    // does not: `registerStatsfmTools(server, client: StatsfmClient = new
    // StatsfmClient())`. Passing Spotify's client there would send every
    // stats.fm request to api.spotify.com, and no schema comparison can see
    // it — the failure is at call time, in a request this suite never makes.
    // The manifest entry is the only place that decision is recorded, so the
    // guard reads the source of every registrar and pins the arity.
    const client = new SpotifyClient();
    for (const module of REGISTRAR_MANIFEST) {
      if (!module.file.startsWith('src/tools/')) continue;
      const source = readFileSync(join(REPO_ROOT, module.file), 'utf8');
      const signature = new RegExp(`export (?:async )?function ${module.name}\\s*\\(([^)]*)\\)`).exec(source);
      if (!signature) continue; // a local registrar (receipts), arity is ours
      const params = signature[1].split(',').map((part) => part.trim()).filter(Boolean);
      const statsfmShaped = params.length >= 2 && !/^_?client\??\s*:\s*SpotifyClient/.test(params[1]);
      if (statsfmShaped) {
        assert.equal(module.key, 'statsfm', `${module.key} has an unexpected 2nd parameter: ${params[1]}`);
        const registrar = await module.load();
        // The adapt must swallow the client: call it and confirm the tool
        // registered without the Spotify client ever reaching stats.fm.
        const server = new McpServer({ name: 'statsfm-shape', version: '0.0.0' });
        registrar(server, client);
        const registry = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
        assert.ok(registry.statsfm_resolve_user, 'statsfm must still register its tools');
      }
    }
  });
});

describe('#906 the startup budget gates still run over lazily loaded modules', () => {
  it('measures a lazily loaded module and clears its real ceiling', async () => {
    const server = new McpServer({ name: 'lazy-in-budget', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), ALL_ACTIVE, [
      // The real module, imported the way the manifest imports it.
      REGISTRAR_MANIFEST.find((module) => module.key === 'search')!,
    ]);
    const rows = collectModuleSchemaBudgets(server);
    const search = rows.find((row) => row.module === 'search');
    assert.ok(search, 'the lazily loaded module must produce a measured row');
    assert.equal(search.status, 'active');
    assert.ok(search.toolCount > 0, 'a lazily loaded module must be measured, not skipped');
    assert.ok(search.schemaBytes > 0);
    assert.doesNotThrow(() => assertModuleSchemaBudgets(rows));
  });

  it('fails the per-module gate when a lazily loaded module exceeds its ceiling', async () => {
    // The breach is manufactured by registering a fat local registrar under a
    // real manifest key, so the row, the ceiling and the verdict all come from
    // the production producer and the production gate. Making a real module
    // breach its real ceiling instead would mean editing the hand-maintained
    // baselines in annotations.ts, which is explicitly out of scope here.
    const server = new McpServer({ name: 'lazy-over-budget', version: '0.0.0' });
    const fat = manifestEntry('search', 'search', localModule('src/tools/annotations.ts', 'probeRegistrar', (target) => {
      for (let i = 0; i < 50; i++) {
        target.tool(`probe_${i}`, 'probe', {}, async () => ({ content: [] }));
      }
    }), [1, 1821]);

    const loaded = await loadManifestRegistrars([fat], ALL_ACTIVE);
    for (const module of loaded) registerManifestModule(server, new SpotifyClient(), module, ALL_ACTIVE);

    const rows = collectModuleSchemaBudgets(server);
    const search = rows.find((row) => row.module === 'search');
    assert.equal(search?.toolCount, 50, 'precondition: the probe registered over the real ceiling');
    assert.throws(
      () => assertModuleSchemaBudgets(rows),
      /exceeds schema budget/,
      'a lazily loaded module over its ceiling must fail server startup',
    );
  });

  it('fails the aggregate gate after lazy registration', async () => {
    const server = new McpServer({ name: 'lazy-aggregate', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), contextForToolsets('playback'));
    const baseline = collectAggregateSurfaceMeasurement(server);
    assert.ok(baseline.toolCount > 0, 'precondition: the trimmed surface registered something');
    assert.doesNotThrow(() => assertAggregateSurfaceBudget(baseline));

    for (let i = 0; i <= AGGREGATE_SURFACE_LIMITS.maxTools; i++) {
      server.tool(`aggregate_probe_${i}`, 'probe', {}, async () => ({ content: [] }));
    }
    const over = collectAggregateSurfaceMeasurement(server);
    assert.ok(over.toolCount > AGGREGATE_SURFACE_LIMITS.maxTools, 'precondition: the surface really is over');
    assert.throws(() => assertAggregateSurfaceBudget(over), /aggregate tool surface exceeds budget/);
  });
});

describe('#906 the toolset gate decides what is loaded, not just what is registered', () => {
  it('leaves every trimmed module unresolved in the manifest it returns', async () => {
    const resolved = await loadManifestRegistrars(REGISTRAR_MANIFEST, contextForToolsets('playback'));
    const unresolved = resolved.filter((module) => module.registrar === undefined).map((module) => module.key);

    // Trimmed modules come back unresolved rather than dropped, so
    // registerManifestModule still records a status row for each and
    // `toolset_report` and the budget table keep seeing the full manifest.
    assert.equal(resolved.length, REGISTRAR_MANIFEST.length, 'no module may be dropped from the manifest');
    for (const key of ['playlists', 'library', 'swarm4playlists', 'statsfm', 'tastecomposites']) {
      assert.ok(unresolved.includes(key), `${key} is trimmed under playback and must stay unresolved`);
    }
    // `doctor` and `swarm3meta` are alwaysActive, so they must load even under
    // a trim — a module the gate cannot switch off is a module that must work.
    for (const key of ['doctor', 'swarm3meta']) {
      assert.ok(!unresolved.includes(key), `${key} is alwaysActive and must still load under a trim`);
    }
  });

  it('records a status row for every manifest module, loaded or not', async () => {
    const server = new McpServer({ name: 'status-rows', version: '0.0.0' });
    await registerManifestModules(server, new SpotifyClient(), contextForToolsets('playback'));
    const rows = collectModuleSchemaBudgets(server);
    assert.equal(rows.length, REGISTRAR_MANIFEST.length);
    // A trimmed module must report itself trimmed, not default to 'active':
    // `collectModuleSchemaBudgets` falls back to 'active' for a key it has
    // never seen, which is exactly what a dropped module would look like.
    const trimmed = rows.filter((row) => row.status === 'toolset_trimmed').map((row) => row.module);
    assert.ok(trimmed.includes('playlists'), 'a trimmed module must report toolset_trimmed, not default to active');
    assert.equal(trimmed.includes('doctor'), false, 'an alwaysActive module is never toolset_trimmed');
  });
});
