/**
 * Mutation conformance guard (#920).
 *
 * Registry-wide invariant: every write-capable tool exposes `dry_run` and
 * `response_format` in its input schema, unless it is allowlisted with a
 * one-line reason (local sidecars only — nothing previewable, nothing to
 * serialize for a verifier).
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
 * - dry_run (2): pin_playlist [A6 slice], save_artist_new_releases
 *   [artistwatch unit]; follow_artists already fixed via #933/#941.
 * - response_format (17): add_to_playlist, create_playlist,
 *   clone_playlist_cover, jump_to_chapter, playlist_collab_toggle,
 *   playlist_reverse, playlist_shuffle, playlist_subtract, playlist_trim,
 *   playlist_union, remove_duplicate_playlist_items, remove_from_playlist,
 *   reorder_playlist_items, replace_playlist_items, split_playlist,
 *   update_playlist, upload_playlist_cover [response_format retrofit unit].
 * - SPEC.md: separate unit.
 *
 * Run: node --import tsx --test tests/mutations.conformance.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { SpotifyClient } from '../src/client.js';
import { verifyReceipt, formatReceipt } from '../src/receipts.js';
import { registerPlaybackTools } from '../src/tools/playback.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerCatalogTools } from '../src/tools/catalog.js';
import { registerPersonalizationTools } from '../src/tools/personalization.js';
import { registerLibraryTools } from '../src/tools/library.js';
import { registerFollowingTools } from '../src/tools/following.js';
import { registerAudiobookTools } from '../src/tools/audiobooks.js';
import { registerPlaylistTools } from '../src/tools/playlists.js';
import { registerUsersTools } from '../src/tools/users.js';
import { registerPlaylistOpsTools } from '../src/tools/playlistops.js';
import { registerLibraryInsightsTools } from '../src/tools/libraryinsights.js';
import { registerFreshnessTools } from '../src/tools/freshness.js';
import { registerSearchDeepTool } from '../src/tools/searchdive.js';
import { registerPodcastSessionTools } from '../src/tools/podcastsession.js';
import { registerAudiobookCopilotTools } from '../src/tools/audiobookcopilot.js';
import { registerScenesTools } from '../src/tools/scenes.js';
import { registerPlaylistDnaTools } from '../src/tools/playlistdna.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';
import { registerExportTools } from '../src/tools/export.js';
import { registerImportTools } from '../src/tools/import.js';
import { registerSmartTools } from '../src/tools/smart.js';
import { registerShowRadarTools } from '../src/tools/showradar.js';
import { registerSavedDedupeTools } from '../src/tools/saveddedupe.js';
import { registerBackupTools } from '../src/tools/backup.js';
import { registerRestoreTools } from '../src/tools/restore.js';
import { registerUndoTools } from '../src/tools/undo.js';
import { registerBackupFirstTools } from '../src/tools/backupfirst.js';
import { registerLibraryHygieneTools } from '../src/tools/libraryhygiene.js';
import { registerBrowseTools } from '../src/tools/browse.js';
import { registerArtistWatchTools } from '../src/tools/artistwatch.js';
import { registerLibraryAnalyticsTools } from '../src/tools/libraryanalytics.js';
import { registerPlaylistHealthTools } from '../src/tools/playlisthealth.js';
import { registerPlaylistBatchTools } from '../src/tools/playlistbatch.js';
import { registerPlaylistMiscTools } from '../src/tools/playlistmisc.js';
import { registerPortabilityTools } from '../src/tools/portability.js';
import { registerQueueOpsTools } from '../src/tools/queueops.js';
import { registerPlaybackExtTools } from '../src/tools/playbackext.js';
import { registerPlaybackIntelTools } from '../src/tools/playbackintel.js';
import { registerSearchHistoryTools } from '../src/tools/searchhistory.js';
import { registerExhaustMiscTools } from '../src/tools/exhaustmisc.js';
import { registerExhaust2CatalogTools } from '../src/tools/exhaust2_catalog.js';
import { registerExhaust2PlaybackTools } from '../src/tools/exhaust2_playback.js';
import { registerExhaust2PlaylistsTools } from '../src/tools/exhaust2_playlists.js';
import { registerExhaust2MiscTools } from '../src/tools/exhaust2_misc.js';
import { registerExhaust2EnggatingTools } from '../src/tools/exhaust2_enggating.js';
import { registerExhaust2ExtraTools } from '../src/tools/exhaust2_extra.js';
import { registerEpisodeMgmtTools } from '../src/tools/episodemgmt.js';
import { registerDoctorTool } from '../src/tools/doctortool.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';
import { registerSwarm3PlaylistopsTools } from '../src/tools/swarm3_playlistops.js';
import { registerSwarm3DiscoveryTools } from '../src/tools/swarm3_discovery.js';
import { registerSwarm3bDiscoveryTools } from '../src/tools/swarm3b_discovery.js';
import { registerSwarm4PlaylistsTools } from '../src/tools/swarm4_playlists.js';
import { registerSwarm3LibraryTools } from '../src/tools/swarm3_library.js';
import { registerSwarm3ShowsTools } from '../src/tools/swarm3_shows.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';
import { registerStatsfmTasteTools } from '../src/tools/statsfm_taste.js';
import { registerTasteCompositeTools } from '../src/tools/taste_composites.js';
import { registerSwarm3RefsTools } from '../src/tools/swarm3_refs.js';
import { registerSwarm3SnapshotsTools } from '../src/tools/swarm3_snapshots.js';
import { registerSwarm3MetaTools } from '../src/tools/swarm3_meta.js';
import { registerStatsfmTools } from '../src/tools/statsfm.js';

// ---------------------------------------------------------------------------
// Module table: key → registrar + source file. Keys mirror src/index.ts;
// files feed both the chunk analysis and loop-registration fallback below.
// ---------------------------------------------------------------------------

type Registrar = (server: McpServer, client: SpotifyClient) => void;

const MODULES: Array<{ key: string; register: Registrar }> = [
  { key: 'playback', register: registerPlaybackTools },
  { key: 'search', register: registerSearchTools },
  { key: 'catalog', register: registerCatalogTools },
  { key: 'personalization', register: registerPersonalizationTools },
  { key: 'library', register: registerLibraryTools },
  { key: 'following', register: registerFollowingTools },
  { key: 'audiobooks', register: registerAudiobookTools },
  { key: 'playlists', register: registerPlaylistTools },
  { key: 'users', register: registerUsersTools },
  { key: 'playlistops', register: registerPlaylistOpsTools },
  { key: 'libraryinsights', register: registerLibraryInsightsTools },
  { key: 'freshness', register: registerFreshnessTools },
  { key: 'searchdeep', register: registerSearchDeepTool },
  { key: 'podcastsession', register: registerPodcastSessionTools },
  { key: 'audiobookcopilot', register: registerAudiobookCopilotTools },
  { key: 'scenes', register: registerScenesTools },
  { key: 'playlistdna', register: registerPlaylistDnaTools },
  { key: 'analytics', register: registerAnalyticsTools },
  { key: 'export', register: registerExportTools },
  { key: 'import', register: registerImportTools },
  { key: 'smart', register: registerSmartTools },
  { key: 'showradar', register: registerShowRadarTools },
  { key: 'saveddedupe', register: registerSavedDedupeTools },
  { key: 'backup', register: registerBackupTools },
  { key: 'restore', register: registerRestoreTools },
  { key: 'undo', register: registerUndoTools },
  { key: 'backupfirst', register: registerBackupFirstTools },
  { key: 'libraryhygiene', register: registerLibraryHygieneTools },
  { key: 'browse', register: registerBrowseTools },
  { key: 'artistwatch', register: registerArtistWatchTools },
  { key: 'libraryanalytics', register: registerLibraryAnalyticsTools },
  { key: 'playlisthealth', register: registerPlaylistHealthTools },
  { key: 'playlistbatch', register: registerPlaylistBatchTools },
  { key: 'playlistmisc', register: registerPlaylistMiscTools },
  { key: 'portability', register: registerPortabilityTools },
  { key: 'queueops', register: registerQueueOpsTools },
  { key: 'playbackext', register: registerPlaybackExtTools },
  { key: 'playbackintel', register: registerPlaybackIntelTools },
  { key: 'searchhistory', register: registerSearchHistoryTools },
  { key: 'exhaustmisc', register: registerExhaustMiscTools },
  { key: 'exhaust2catalog', register: registerExhaust2CatalogTools },
  { key: 'exhaust2playback', register: registerExhaust2PlaybackTools },
  { key: 'exhaust2playlists', register: registerExhaust2PlaylistsTools },
  { key: 'exhaust2misc', register: registerExhaust2MiscTools },
  { key: 'exhaust2enggating', register: registerExhaust2EnggatingTools },
  { key: 'exhaust2extra', register: registerExhaust2ExtraTools },
  { key: 'episodemgmt', register: registerEpisodeMgmtTools },
  { key: 'doctor', register: registerDoctorTool },
  { key: 'swarm3playback', register: registerSwarm3PlaybackTools },
  { key: 'swarm3playlistops', register: registerSwarm3PlaylistopsTools },
  { key: 'swarm3discovery', register: registerSwarm3DiscoveryTools },
  { key: 'swarm3bdiscovery', register: registerSwarm3bDiscoveryTools },
  { key: 'swarm4playlists', register: registerSwarm4PlaylistsTools },
  { key: 'swarm3library', register: registerSwarm3LibraryTools },
  { key: 'swarm3shows', register: registerSwarm3ShowsTools },
  { key: 'swarm3analytics', register: registerSwarm3AnalyticsTools },
  { key: 'taste', register: registerStatsfmTasteTools },
  { key: 'tastecomposites', register: registerTasteCompositeTools },
  { key: 'swarm3refs', register: registerSwarm3RefsTools },
  { key: 'swarm3snapshots', register: registerSwarm3SnapshotsTools },
  { key: 'statsfm', register: registerStatsfmTools as unknown as Registrar },
  { key: 'meta', register: registerSwarm3MetaTools },
];

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
  'pin_playlist',
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
  'playlist_subtract',
  'playlist_trim',
  'playlist_union',
  'remove_duplicate_playlist_items',
  'remove_from_playlist',
  'reorder_playlist_items',
  'replace_playlist_items',
  'split_playlist',
  'update_playlist',
  'upload_playlist_cover',
];

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
  for (const { key, register } of MODULES) {
    const before = new Set(observed);
    register(server, stub);
    for (const name of observed) {
      if (!before.has(name) && !moduleByTool.has(name)) moduleByTool.set(name, key);
    }
  }
  // verify_receipt is registered inline in src/index.ts (library module,
  // read-only lookup) — mirror that here so the enumeration is whole.
  if (!moduleByTool.has('verify_receipt')) {
    server.tool(
      'verify_receipt',
      'Verify that a previous mutation actually landed on Spotify by looking up its receipt',
      { receipt_id: z.string().min(1).describe('Receipt ID from a receipt-bearing mutation result') },
      async (args) => {
        const receipt = verifyReceipt(args.receipt_id as string);
        if (!receipt) {
          return { content: [{ type: 'text', text: `Unknown receipt "${args.receipt_id as string}".` }] };
        }
        return { content: [{ type: 'text', text: formatReceipt(receipt) }], structuredContent: { ...receipt } };
      },
    );
    moduleByTool.set('verify_receipt', 'library-inline');
  }
  const client = new Client({ name: 'conformance-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(clientTransport), client.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    const tools = listed.tools as ListedTool[];
    return tools
      .map((t) => ({
        name: t.name,
        module: moduleByTool.get(t.name) ?? 'unknown',
        properties: Object.keys(t.inputSchema?.properties ?? {}),
      }))
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
