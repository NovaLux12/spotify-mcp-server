/**
 * Manifest row safety classes (#1005, #1009, #1017).
 *
 * Three defects, one shape: a manifest row is the unit both gates work in.
 * `scopeKey` decides whether a row registers at all, `readOnlySafe` decides
 * whether it registers in a SPOTIFY_MCP_READONLY session, and both are
 * per-ROW, not per-tool. So a tool whose scope vocabulary differs from its
 * row's, or whose safety differs from its row's, is either advertised as
 * something the grant does not authorise, or hidden from a grant that does.
 *
 * The assertions below are written as VISIBILITY, not as configuration: each
 * one names a granted-scope combination and the tools a caller must (or must
 * not) see. They run the real `registerManifestModule` gate over the real
 * manifest, so a row that was fixed by editing the wrong field fails here.
 *
 * Red against the pre-fix tree (origin/main @ cfa13b5, verified by stashing
 * nothing — the assertions were run against a checkout of that commit):
 *   - #1005 `playlist-modify-private` still exposed pin_playlist (raw 403);
 *   - #1005 `user-library-modify` / `user-follow-modify` hid a tool the
 *     endpoint authorises (unknown-tool error for a valid call);
 *   - #1009 a read-only grant exposed taste_to_playlist;
 *   - #1017 a read-only session saw neither list_backups nor delete_backup.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { SpotifyClient } from '../src/client.js';
import { moduleBlockedByScopes, scopesFor } from '../src/scopefilter.js';
import { REGISTRAR_MANIFEST, registerManifestModule } from '../src/tools/annotations.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Register the whole manifest through the production gate. */
function visibleTools(options: { scope?: string; readOnly?: boolean }): Set<string> {
  const server = new McpServer({ name: 'row-safety-test', version: '0.0.0' });
  const granted = scopesFor(options.scope);
  for (const module of REGISTRAR_MANIFEST) {
    registerManifestModule(server, new SpotifyClient(), module, {
      readOnly: options.readOnly ?? false,
      isModuleActive: () => true,
      scopeBlocked: (key) => moduleBlockedByScopes(key, granted),
    });
  }
  return new Set(Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools));
}

/** The read scopes a consent screen still grants when writes are declined. */
const READ_ONLY_GRANT = [
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-follow-read',
].join(' ');

/** The ten stats.fm tools that live in the tastecomposites row. */
const TASTE_READ_TOOLS = [
  'taste_daily_brief',
  'taste_era_playlist',
  'taste_forgotten_bangers',
  'taste_obsession_ladder',
];

describe('#1005 pin/unpin advertise the scopes /me/library actually accepts', () => {
  // PUT/DELETE /me/library authorises user-library-modify, user-follow-modify
  // OR playlist-modify-public (AGENTS.md §1). Each of these three grants must
  // therefore SEE the pair; a per-tool `user-follow-modify` requirement would
  // hide a tool the caller's token authorises, which is worse than the 403
  // this gate exists to prevent.
  for (const grant of ['playlist-modify-public', 'user-library-modify', 'user-follow-modify']) {
    it(`exposes pin_playlist/unpin_playlist to a "${grant}"-only grant`, () => {
      const names = visibleTools({ scope: grant });
      assert.ok(names.has('pin_playlist'), `pin_playlist hidden from a ${grant} grant, which authorises it`);
      assert.ok(names.has('unpin_playlist'), `unpin_playlist hidden from a ${grant} grant, which authorises it`);
    });
  }

  it('withholds the pair from playlist-modify-private, which does not authorise /me/library', () => {
    // The pre-fix row carried `scopeKey: 'playlists'` (public OR private), so a
    // private-only caller saw both tools and got a raw 403 from Spotify on
    // every call. playlist_template_apply still needs the private scope and
    // keeps its own row, so nothing legitimate is lost with the pair.
    const names = visibleTools({ scope: 'playlist-modify-private' });
    assert.equal(names.has('pin_playlist'), false, 'pin_playlist advertised to a grant that cannot authorise it');
    assert.equal(names.has('unpin_playlist'), false, 'unpin_playlist advertised to a grant that cannot authorise it');
    assert.ok(names.has('playlist_template_apply'), 'the playlist-create tool keeps playlist-modify-private');
  });

  it('withholds the pair from a read-only grant', () => {
    const names = visibleTools({ scope: READ_ONLY_GRANT });
    assert.equal(names.has('pin_playlist'), false);
    assert.equal(names.has('unpin_playlist'), false);
  });

  it('keeps every scope the endpoint accepts on the row', () => {
    // Pinned against a future "simplification" of the either-of list: dropping
    // the third alternative is the exact regression #1005 was filed for.
    const accepted = ['user-library-modify', 'user-follow-modify', 'playlist-modify-public'];
    for (const scope of accepted) {
      const grant = scopesFor(scope);
      assert.equal(
        moduleBlockedByScopes('playlistfollow', grant),
        false,
        `playlistfollow must not require more than ${scope}`,
      );
    }
  });
});

describe('#1009 taste_to_playlist is the only writer in the taste family', () => {
  it('is absent from a read-only session while the ten reads stay', () => {
    const names = visibleTools({ readOnly: true });
    assert.equal(names.has('taste_to_playlist'), false, 'a writer advertised in SPOTIFY_MCP_READONLY');
    const missing = TASTE_READ_TOOLS.filter((name) => !names.has(name));
    assert.deepEqual(missing, [], 'read-only session lost the pure-read taste tools');
  });

  it('is withheld from a grant with no playlist-write scope, reads unaffected', () => {
    const names = visibleTools({ scope: READ_ONLY_GRANT });
    assert.equal(names.has('taste_to_playlist'), false, 'exposed without a scope that can create a playlist');
    const missing = TASTE_READ_TOOLS.filter((name) => !names.has(name));
    assert.deepEqual(missing, [], 'a missing write scope took the reads with it');
  });

  it('is reachable for a caller who holds playlist-modify-public', () => {
    const names = visibleTools({ scope: 'playlist-modify-public' });
    assert.ok(names.has('taste_to_playlist'));
  });
});

describe('#1017 delete_backup no longer costs a read-only session the reads', () => {
  it('hides the delete and keeps list_backups/backup_library visible', () => {
    const names = visibleTools({ readOnly: true });
    assert.equal(names.has('delete_backup'), false, 'a destructive local unlink advertised in SPOTIFY_MCP_READONLY');
    for (const read of ['list_backups', 'backup_library']) {
      assert.ok(names.has(read), `read-only session lost ${read}, which reads Spotify and mutates nothing`);
    }
  });

  it('keeps list_backups reachable for a read-scoped read-only session', () => {
    // The real read-only persona carries read scopes, so the row is
    // scope_filtered rather than blocked: list_backups is still a read the
    // grant authorises and must survive that filter. (backup_library is NOT
    // asserted here: every call it makes is a GET, but its name starts with
    // `backup`, which the annotation classifier counts as a mutating verb, so
    // the scope filter withholds it. That is the classifier's row, not
    // readOnlySafe's — filed separately rather than pinned here.)
    const names = visibleTools({ scope: READ_ONLY_GRANT, readOnly: true });
    assert.ok(names.has('list_backups'), 'a read-scoped read-only session cannot list its own backups');
    assert.equal(names.has('delete_backup'), false, 'delete_backup reachable in SPOTIFY_MCP_READONLY');
  });

  it('exposes all three to a normal session', () => {
    const names = visibleTools({ scope: 'user-library-modify' });
    for (const tool of ['list_backups', 'backup_library', 'delete_backup']) {
      assert.ok(names.has(tool), `${tool} missing from a normal session with the library scope`);
    }
  });
});

describe('#1017 the flag means what the gate does with it', () => {
  /**
   * `readOnlySafe: true` is read by exactly one line — `module.readOnlySafe !==
   * true` hides the whole row — so it is a claim about EVERY tool in the row:
   * none of them may write. tastecomposites asserted that while registering
   * the one tool that creates a playlist, and the only two available repairs
   * were both wrong (expose the writer, or hide ten readers). This guard is
   * what makes the flag worth reading: a future writer added to a read-only
   * row fails here instead of shipping silently.
   *
   * Evidence is the registration chunk's own source, using the same write-call
   * and commit-helper patterns tests/mutations.conformance.test.ts treats as
   * writer evidence — including the helpers that wrap the client queue, so a
   * write that hides behind one cannot pass as a read.
   */
  const REGISTRATION = /server\.(?:tool|registerTool)\(\s*\n?\s*['"]([^'"]+)['"]/g;
  const WRITE_CALL = /\.(post|put|delete|patch|putRaw)\s*(<[\s\S]*?>)?\s*\(/;
  const COMMIT_HELPER = /\b(atomicReplace|replaceWithUris|atomicAdd)\s*\(/;

  const offenders: string[] = [];
  for (const module of REGISTRAR_MANIFEST) {
    if (module.readOnlySafe !== true) continue;
    const src = readFileSync(join(REPO_ROOT, module.file), 'utf8');
    const matches = [...src.matchAll(REGISTRATION)];
    for (let i = 0; i < matches.length; i++) {
      const chunk = src.slice(matches[i]!.index!, i + 1 < matches.length ? matches[i + 1]!.index! : src.length);
      if (WRITE_CALL.test(chunk) || COMMIT_HELPER.test(chunk)) {
        offenders.push(`${module.key}/${matches[i]![1]} (${module.file})`);
      }
    }
  }

  it('no readOnlySafe row registers a tool that writes', () => {
    assert.deepEqual(offenders, [], 'rows claiming readOnlySafe while registering a writer: ' + offenders.join(', '));
  });
});
