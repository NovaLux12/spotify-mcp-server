import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SpotifyClient } from '../src/client.js';
import { moduleBlockedByScopes, scopesFor } from '../src/scopefilter.js';
import {
  REGISTRAR_MANIFEST,
  assertModuleSchemaBudgets,
  classifyToolAnnotations,
  collectModuleSchemaBudgets,
  moduleToolNames,
  registerManifestModule,
} from '../src/tools/annotations.js';

/**
 * A grant carrying only the read scopes a consent screen still asks for when
 * the operator declines the write scopes. Every tool below is registered by a
 * module whose effective scopeKey is a WRITE_SCOPE_REQUIREMENTS key, so a
 * module-level gate hid them along with the writers.
 */
const READ_ONLY_GRANT = [
  'user-read-private',
  'user-read-email',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-follow-read',
  'user-top-read',
].join(' ');

/** Writers the module-level gate was written to hide. */
const WRITE_TOOLS = [
  'save_to_library',
  'remove_from_library',
  'create_playlist',
  'add_to_playlist',
  'follow_artists',
  'unfollow_artists',
  'play',
  'add_to_queue',
  'transfer_playback',
  'undo_mutation',
  'restore_library_snapshot',
];

/** Tools that read Spotify but live in modules that are not readOnlySafe. */
const READ_TOOLS_OF_WRITE_MODULES = [
  'get_saved_tracks',
  'get_saved_albums',
  'get_saved_counts',
  'search_saved_tracks',
  'check_in_library',
  'get_user_playlists',
  'get_playlist',
  'get_playlist_items',
  'get_playlist_cover',
  'check_playlist_following',
  'get_followed_artists',
  'check_following_artists',
  'get_now_playing',
  'get_queue',
  'get_devices',
  'list_backups',
  'verify_receipt',
];

function register(options: { scope?: string; readOnly?: boolean }): McpServer {
  const server = new McpServer({ name: 'scope-filter-test', version: '0.0.0' });
  const granted = scopesFor(options.scope);
  for (const module of REGISTRAR_MANIFEST) {
    registerManifestModule(server, new SpotifyClient(), module, {
      readOnly: options.readOnly ?? false,
      isModuleActive: () => true,
      scopeBlocked: (key) => moduleBlockedByScopes(key, granted),
    });
  }
  return server;
}

function toolNames(server: McpServer): string[] {
  return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
}

/** Modules the scope gate registered reads-only instead of skipping. */
function filteredModuleKeys(server: McpServer): string[] {
  return collectModuleSchemaBudgets(server)
    .filter((row) => row.status === 'scope_filtered')
    .map((row) => row.module);
}

describe('scope-filtered module registration (#1020)', () => {
  it('keeps the read tools of write-gated modules reachable under a read-only grant', () => {
    const names = new Set(toolNames(register({ scope: READ_ONLY_GRANT })));
    const missing = READ_TOOLS_OF_WRITE_MODULES.filter((name) => !names.has(name));
    assert.deepEqual(missing, [], `read tools absent from tools/list under a read-only grant: [${missing.join(', ')}]`);
  });

  it('withholds every writer of those modules under the same grant', () => {
    const names = new Set(toolNames(register({ scope: READ_ONLY_GRANT })));
    const leaked = WRITE_TOOLS.filter((name) => names.has(name));
    assert.deepEqual(leaked, [], `write tools exposed without their write scope: [${leaked.join(', ')}]`);
  });

  it('exposes no tool the read/write classifier cannot prove read-only', () => {
    const server = register({ scope: READ_ONLY_GRANT });
    const names = toolNames(server);
    assert.ok(names.length > 0, 'the read-only grant must still register a surface');
    const registered = new Set(names);
    const unproven = filteredModuleKeys(server)
      .flatMap((module) => moduleToolNames(server, module))
      .filter((name) => classifyToolAnnotations(name).readOnlyHint !== true);
    assert.deepEqual(unproven, [], `non-read tools exposed by a scope_filtered module: [${unproven.join(', ')}]`);
    // Every tool a filtered module kept must be in the registry, so the
    // ownership record and tools/list cannot disagree.
    const owned = filteredModuleKeys(server).flatMap((module) => moduleToolNames(server, module));
    assert.ok(owned.every((name) => registered.has(name)), 'a filtered module reported a tool it did not register');
  });
  it('reports the partially registered modules instead of an absent one', () => {
    const server = register({ scope: READ_ONLY_GRANT });
    const filtered = new Set(filteredModuleKeys(server));
    assert.ok(filtered.has('library') && filtered.has('playlists') && filtered.has('following'),
      `expected the three scope-gated registration keys to be scope_filtered, got [${[...filtered].join(', ')}]`);
    assert.ok(moduleToolNames(server, 'library').length > 0, 'a scope_filtered module must own its surviving tools');
    assert.deepEqual(
      moduleToolNames(server, 'library').sort(),
      ['check_in_library', 'check_saved_items', 'get_saved_albums', 'get_saved_counts', 'get_saved_episodes',
        'get_saved_shows', 'get_saved_tracks', 'search_saved_albums', 'search_saved_audiobooks', 'search_saved_episodes',
        'search_saved_shows', 'search_saved_tracks'],
      'the library module must register exactly its read-classified tools',
    );
  });

  it('keeps the schema budget measured for a partially registered module', () => {
    const server = register({ scope: READ_ONLY_GRANT });
    const rows = collectModuleSchemaBudgets(server);
    const library = rows.find((row) => row.module === 'library');
    assert.ok(library && library.status === 'scope_filtered', 'library must report the filtered status');
    assert.ok(library.toolCount > 0 && library.schemaBytes > 0, 'a filtered row must still be measured');
    assert.doesNotThrow(() => assertModuleSchemaBudgets(rows));
  });

  it('registers the unchanged full surface when no scope information exists', () => {
    const failOpen = toolNames(register({})).sort();
    const unfiltered = toolNames(register({ scope: 'user-modify-playback-state playlist-modify-public user-library-modify user-follow-modify' })).sort();
    assert.deepEqual(failOpen, unfiltered, 'an unscoped token file must register exactly the unfiltered surface');
  });

  it('lets the read-only gate outrank the scope filter', () => {
    const names = new Set(toolNames(register({ scope: READ_ONLY_GRANT, readOnly: true })));
    // #111: modules that are not readOnlySafe register nothing in a READONLY
    // session, so a reduced grant must not become a route to their reads.
    for (const name of ['undo_preview', 'restore_playlist_plan', 'apply_volume_plan', 'save_queue_as_playlist', 'get_saved_tracks']) {
      assert.ok(!names.has(name), `${name} must stay hidden under SPOTIFY_MCP_READONLY`);
    }
    const leaked = ['play_on', 'queue_next', 'pin_playlist', 'save_episode', 'remove_saved_shows', 'follow_artist',
      'unsave_orphan_tracks', 'playlist_to_library', 'save_artist_new_releases', 'remove_from_library_by_playlist']
      .filter((name) => names.has(name));
    assert.deepEqual(leaked, [], `write tools visible under SPOTIFY_MCP_READONLY=1: [${leaked.join(', ')}]`);
  });
});
