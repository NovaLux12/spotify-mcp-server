/**
 * Mutation conformance guard (#920).
 *
 * Registry-wide invariant: every write-capable tool exposes `dry_run` and
 * `response_format` in its input schema, unless it is allowlisted with a
 * one-line reason (local sidecars only — nothing previewable, nothing to
 * serialize for a verifier).
 *
 * #1567 added the second half of the `dry_run` contract: a write tool that
 * declares the flag must also publish what an OMITTED flag does. Checking
 * that the property is *named* `dry_run` passed against `save_to_library`
 * while it committed on omission, and it would equally have passed against
 * an inverted `default` — the name is the same either way. The two
 * `dry_run` tests below therefore read the property's `default` from the
 * live schema, not just its presence.
 *
 * Enumeration uses the live registry: every slice registrar runs on one real
 * McpServer and the surface is read back over InMemoryTransport via
 * tools/list (JSON Schema properties) — the same path a host uses. The test
 * never touches the SDK's private registry: no second walker lives here.
 *
 * Writer classification follows the assignment: a tool is a writer when its
 * registration chunk in src/tools/* contains client.post|put|delete call
 * sites (direct, generic-typed incl. `;`/newlines, casted, putRaw, or via
 * the commit helpers atomicReplace/replaceWithUris/atomicAdd). Name pattern
 * alone never qualifies: most `*_plan`/`*_preview`/`export_*`/`snapshot_*`
 * names look mutating while their handlers only read.
 *
 * Known gaps pending sibling slices (green contract — do NOT retrofit here):
 * the guard passes while the only missing tools are the listed known gaps.
 * When a sibling slice lands, delete its entries from the list below; the
 * guard then enforces the newly-closed invariant.
 * - dry_run (1): save_artist_new_releases
 *   [artistwatch unit]; #638 deleted follow_artists with the endpoint it used.
 * - response_format (15): add_to_playlist, create_playlist,
 *   clone_playlist_cover, jump_to_chapter, playlist_collab_toggle,
 *   playlist_reverse, playlist_shuffle, playlist_trim,
 *   remove_duplicate_playlist_items, remove_from_playlist,
 *   reorder_playlist_items, replace_playlist_items, split_playlist,
 *   update_playlist, upload_playlist_cover [response_format retrofit unit].
 * - SPEC.md: separate unit.
 *
 * Run: node --import tsx --test tests/mutations.conformance.test.ts
 */
import './helpers/hermetic.js';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpotifyClient } from '../src/client.js';
import { REGISTRAR_MANIFEST, loadManifestRegistrars } from '../src/tools/annotations.js';

/**
 * Explicit allowlist: genuine non-previewable locals. Each entry needs a
 * one-line reason — anything without one fails the guard. Only local
 * sidecars qualify (no Spotify mutation to preview, no verifier payload).
 */
const ALLOWLIST: Record<string, string> = {
  delete_scene: 'local sidecar slot deletion — single-key drop, nothing to preview',
  rename_device: 'local sidecar label write — no Spotify call, nothing to preview',
  save_playback_state: 'local sidecar snapshot write — captures current state, nothing to preview',
  save_scene: 'local sidecar slot write — captures current state, nothing to preview',
  save_smart_playlist_rule: 'local sidecar rule write — stores a rule object, nothing to preview',
  set_device_volume_preset: 'local sidecar preset write — stores one number, nothing to preview',
};

/**
 * Known gaps: write tools whose sibling slices have not landed yet. The
 * guard asserts missing == known (green now); landing a slice means
 * deleting its entries here, which keeps the invariant enforced.
 */
const KNOWN_MISSING_DRY_RUN: string[] = [
  'save_artist_new_releases',
];
const KNOWN_MISSING_RESPONSE_FORMAT: string[] = [
  'add_to_playlist',
  'clone_playlist_cover',
  'create_playlist',
  'jump_to_chapter',
  'playlist_collab_toggle',
  'playlist_reverse',
  'playlist_shuffle',
  'playlist_trim',
  'remove_duplicate_playlist_items',
  'remove_from_playlist',
  'reorder_playlist_items',
  'replace_playlist_items',
  'split_playlist',
  'update_playlist',
  'upload_playlist_cover',
];

/**
 * #1567: the same known-gap idiom, one level down. A write tool may declare
 * `dry_run` without publishing a default — that is the gap, not the contract.
 * Every name here is a tool whose handler branches on the flag while the
 * emitted `tools/list` entry tells a host nothing about what an omitted flag
 * does, which is how `save_to_library` committed with no preview and no way
 * for the caller to have known.
 *
 * This list is a green contract, not an excuse. Fixing a tool means deleting
 * its entry, and the deepEqual below fails if the set changes for any other
 * reason, so the list cannot quietly rot into a permanent exemption.
 */
const KNOWN_MISSING_DRY_RUN_DEFAULT: string[] = [
  'add_to_playlist',
  'batch_add_to_playlist',
  'clean_all_playlists',
  'clone_playlist_cover',
  'copy_playlist',
  'create_playlist',
  'create_smart_playlist',
  'jump_to_chapter',
  'merge_playlists',
  'move_items_between_playlists',
  'playlist_collab_toggle',
  'playlist_cover_from_track',
  'playlist_expression_algebra',
  'playlist_reverse',
  'playlist_shuffle',
  'playlist_sort',
  'playlist_subtract',
  'playlist_template_apply',
  'playlist_to_library',
  'playlist_trim',
  'playlist_union',
  'remove_duplicate_playlist_items',
  'remove_from_playlist',
  'remove_unavailable_playlist_items',
  'reorder_playlist_items',
  'replace_playlist_items',
  'split_playlist',
  'start_podcast_session',
  'update_playlist',
  'upload_playlist_cover',
];

/**
 * #1567: write tools that deliberately commit on an omitted `dry_run`, each
 * with the reason it is not the #827 preview-by-default convention. Anything
 * without a reason fails the guard.
 *
 * The playback family is NOT listed here — it is derived from the manifest's
 * own `scopeKey: 'playback'` grouping instead (see PLAYBACK_MODULES), the same
 * way tests/tools.dry-run-contract.test.ts derives it, so a new playback
 * module is covered by construction rather than by remembering to edit a
 * constant.
 */
const COMMIT_BY_DEFAULT: Record<string, string> = {
  import_playlist:
    'imports into an existing playlist by appending — its own local zod '
    + 'fragment declares `default: false` (src/tools/import.ts) so a host can '
    + 'see the commit; the preview default is a separate retrofit',
};

/** Modules the manifest groups as playback. Derived, not hand-maintained. */
const PLAYBACK_MODULES = new Set(
  REGISTRAR_MANIFEST.filter((m) => m.scopeKey === 'playback').map((m) => m.key),
);

// ---------------------------------------------------------------------------
// Writer evidence: per-tool registration chunks in src/tools/*.
// ---------------------------------------------------------------------------

/** Direct Spotify writes: plain, generic-typed (`client.post<T>(`, generics may hold `;`/newlines), and casted (`}).put(`). */
const WRITE_CALL = /\.(post|put|delete|putRaw)\s*(<[\s\S]*?>)?\s*\(/;
/** Commit helpers that wrap the client queue (same write effects). */
const COMMIT_HELPER = /\b(atomicReplace|replaceWithUris|atomicAdd)\s*\(/;
const REGISTRATION = /server\.(?:tool|registerTool)\(\s*\n?\s*['"]([^'"]+)['"]/g;

interface ModuleEvidence {
  /** Tools whose registration chunk contains write call sites. */
  chunkWriters: Set<string>;
}

function collectWriterEvidence(): ModuleEvidence {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const toolsDir = join(srcRoot, 'tools');
  const files = readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(toolsDir, f));
  files.push(join(srcRoot, 'index.ts'));
  const chunkWriters = new Set<string>();
  for (const file of files) {
    const txt = readFileSync(file, 'utf8');
    const matches = [...txt.matchAll(REGISTRATION)];
    for (let i = 0; i < matches.length; i++) {
      const name = matches[i]![1]!;
      const end = i + 1 < matches.length ? matches[i + 1]!.index! : txt.length;
      const chunk = txt.slice(matches[i]!.index!, end);
      if (WRITE_CALL.test(chunk) || COMMIT_HELPER.test(chunk)) chunkWriters.add(name);
    }
  }
  return { chunkWriters };
}

// ---------------------------------------------------------------------------
// Live registry harness: every registrar on one real McpServer, surface read
// via tools/list over InMemoryTransport.
// ---------------------------------------------------------------------------

interface SurfacedTool {
  name: string;
  module: string;
  properties: string[];
  /** The raw `dry_run` JSON Schema property: `undefined` when absent. */
  dryRun?: { default?: unknown };
}

interface ListedTool {
  name: string;
  inputSchema?: { properties?: Record<string, unknown> };
}

async function enumerateLiveRegistry(): Promise<SurfacedTool[]> {
  const stub = {
    get: async () => null,
    post: async () => null,
    put: async () => null,
    delete: async () => null,
    getAllPages: async () => [],
  } as unknown as SpotifyClient;
  const server = new McpServer({ name: 'conformance-probe', version: '0.0.0' });
  // Record names per module by wrapping the public registration methods;
  // registration itself still runs on the real server, so tools/list reads
  // the genuine registry.
  const moduleByTool = new Map<string, string>();
  const wrappable = server as unknown as {
    tool: (...args: unknown[]) => unknown;
    registerTool: (...args: unknown[]) => unknown;
  };
  const origTool = wrappable.tool.bind(server);
  const origRegisterTool = wrappable.registerTool.bind(server);
  const observed = new Set<string>();
  wrappable.tool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origTool(...args);
  };
  wrappable.registerTool = (...args: unknown[]) => {
    observed.add(args[0] as string);
    return origRegisterTool(...args);
  };
  // Every module is wanted here, so this probe asks the manifest to resolve
  // them all rather than gating: the point is the full default surface (#906).
  const resolved = await loadManifestRegistrars(REGISTRAR_MANIFEST, {
    readOnly: false,
    disableOverrides: new Set<string>(), isModuleActive: () => true,
    scopeBlocked: () => false,
  });
  for (const { key, registrar } of resolved) {
    const before = new Set(observed);
    assert.ok(registrar, `${key} must be resolved before registration`);
    registrar(server, stub);
    for (const name of observed) {
      if (!before.has(name) && !moduleByTool.has(name)) moduleByTool.set(name, key);
    }
  }
  const client = new Client({ name: 'conformance-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    const tools = listed.tools as ListedTool[];
    return tools
      .map((t) => {
        const properties = (t.inputSchema?.properties ?? {}) as Record<
          string,
          { default?: unknown }
        >;
        return {
          name: t.name,
          module: moduleByTool.get(t.name) ?? 'unknown',
          properties: Object.keys(properties),
          // #1567: kept as the property itself, not just its name, so the
          // default can be asserted below. `'default' in prop` rather than
          // `prop.default !== undefined` — a published `default: false` is a
          // declared default, and reading the value alone would call it absent.
          dryRun: properties.dry_run,
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

/**
 * Writers: registration-chunk write evidence only. Name pattern alone never
 * qualifies — most `*_plan`/`*_preview`/`export_*`/`snapshot_*` names look
 * mutating while their handlers only read, which is #920's own false
 * positive. Loop-registered tools (catalog search_* loops, stats.fm loops)
 * live in files without write call sites, so no writer lacks a chunk.
 */
function writersOf(
  tools: SurfacedTool[],
  evidence: ModuleEvidence,
): SurfacedTool[] {
  return tools.filter((t) => evidence.chunkWriters.has(t.name));
}

describe('mutations conformance guard (#920)', () => {
  it('enumerates the live registry via tools/list (non-empty, deduped)', async () => {
    const tools = await enumerateLiveRegistry();
    assert.ok(tools.length > 400, `expected a full-surface enumeration, got ${tools.length}`);
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, 'duplicate tool names');
  });

  it('every write tool exposes dry_run unless allowlisted with a reason', async () => {
    const writers = writersOf(await enumerateLiveRegistry(), collectWriterEvidence());
    assert.ok(writers.length > 0, 'writer classification matched nothing — check evidence');
    const missing = writers.filter(
      (t) => !t.properties.includes('dry_run') && !(t.name in ALLOWLIST),
    );
    assert.deepEqual(
      missing.map((t) => t.name).sort(),
      [...KNOWN_MISSING_DRY_RUN].sort(),
      `write tools missing dry_run changed (land a slice? update KNOWN_MISSING_DRY_RUN): [${missing
        .map((t) => `${t.name} (${t.module})`)
        .join(', ')}]`,
    );
  });

  it('every write tool that declares dry_run publishes what an omitted flag does', async () => {
    // #1567. The name check above cannot see this: a tool may be named
    // `dry_run` and still say nothing about an omitted flag, which is how
    // `save_to_library` committed with no preview. This asserts the default
    // is *declared*, against the known-gap list rather than a blanket
    // requirement, so the 30 tools still to be retrofitted stay visible as a
    // number that has to go down instead of disappearing.
    const writers = writersOf(await enumerateLiveRegistry(), collectWriterEvidence());
    const withFlag = writers.filter((t) => t.dryRun !== undefined);
    assert.ok(withFlag.length > 0, 'no writer declares dry_run — the probe is vacuous');

    // `'default' in prop`, not `prop.default === undefined`: a tool that
    // publishes `default: false` has declared one.
    const missing = withFlag.filter((t) => !('default' in t.dryRun!));
    assert.deepEqual(
      missing.map((t) => t.name).sort(),
      [...KNOWN_MISSING_DRY_RUN_DEFAULT].sort(),
      `write tools whose dry_run has no published default changed (land a slice? update KNOWN_MISSING_DRY_RUN_DEFAULT): [${missing
        .map((t) => `${t.name} (${t.module})`)
        .join(', ')}]`,
    );
  });

  it('a non-playback write tool previews by default, so an inverted default fails here', async () => {
    // #1567. The value half, which is what the presence half cannot see:
    // flipping `default: true` to `default: false` on a mutating tool would
    // keep the property named `dry_run` and would keep passing every other
    // assertion in this file. #827's `DryRunDefault` is the convention this
    // enforces — every mutating tool previews on an omitted flag — with the
    // playback family's deliberate `default: false` (#836) derived from the
    // manifest, and the one measured non-playback exception named with a
    // reason.
    const writers = writersOf(await enumerateLiveRegistry(), collectWriterEvidence());
    const declaring = writers.filter((t) => t.dryRun !== undefined && 'default' in t.dryRun!);
    assert.ok(declaring.length > 0, 'no writer publishes a dry_run default — the probe is vacuous');

    const wrong = declaring.filter(
      (t) =>
        t.dryRun!.default !== true
        && !PLAYBACK_MODULES.has(t.module)
        && !(t.name in COMMIT_BY_DEFAULT),
    );
    assert.deepEqual(
      wrong
        .map((t) => `${t.name} (${t.module}) = ${JSON.stringify(t.dryRun!.default)}`)
        .sort(),
      [],
      'every non-playback write tool that declares a dry_run default must publish default:true',
    );
  });

  it('every write tool exposes response_format', async () => {
    const writers = writersOf(await enumerateLiveRegistry(), collectWriterEvidence());
    const missing = writers.filter((t) => !t.properties.includes('response_format'));
    assert.deepEqual(
      missing.map((t) => t.name).sort(),
      [...KNOWN_MISSING_RESPONSE_FORMAT].sort(),
      `write tools missing response_format changed (land a slice? update KNOWN_MISSING_RESPONSE_FORMAT): [${missing
        .map((t) => `${t.name} (${t.module})`)
        .join(', ')}]`,
    );
  });

  it('allowlist entries carry a one-line reason and still exist', async () => {
    const names = new Set((await enumerateLiveRegistry()).map((t) => t.name));
    for (const [name, reason] of Object.entries(ALLOWLIST)) {
      assert.ok(names.has(name), `allowlist entry "${name}" is stale — remove it`);
      assert.ok(
        typeof reason === 'string' && reason.trim().length > 0,
        `allowlist entry "${name}" needs a one-line reason`,
      );
    }
  });
});
