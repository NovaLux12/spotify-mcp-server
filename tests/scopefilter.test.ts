import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WRITE_SCOPE_REQUIREMENTS,
  moduleBlockedByScopes,
  scopesFor,
} from '../src/scopefilter.js';

describe('scopesFor', () => {
  it('parses a space-separated scope string into a set', () => {
    assert.deepEqual(scopesFor('user-read-private user-library-modify'), new Set([
      'user-read-private',
      'user-library-modify',
    ]));
  });

  it('tolerates extra whitespace and empty tokens', () => {
    assert.deepEqual(scopesFor('  a   b  '), new Set(['a', 'b']));
  });

  it('returns an empty set for undefined or empty input', () => {
    assert.deepEqual(scopesFor(undefined), new Set());
    assert.deepEqual(scopesFor(''), new Set());
    assert.deepEqual(scopesFor('   '), new Set());
  });

  it('deduplicates repeated scopes', () => {
    assert.deepEqual(scopesFor('a a b'), new Set(['a', 'b']));
  });
});

describe('moduleBlockedByScopes', () => {
  it('blocks playback when user-modify-playback-state is missing', () => {
    assert.equal(moduleBlockedByScopes('playback', scopesFor('user-read-private')), true);
  });

  it('unblocks playback when the modify scope is granted', () => {
    assert.equal(
      moduleBlockedByScopes('playback', scopesFor('user-read-private user-modify-playback-state')),
      false,
    );
  });

  it('either-of semantics for playlists: public alone suffices', () => {
    assert.equal(
      moduleBlockedByScopes('playlists', scopesFor('playlist-modify-public')),
      false,
    );
  });

  it('either-of semantics for playlists: private alone suffices', () => {
    assert.equal(
      moduleBlockedByScopes('playlists', scopesFor('playlist-modify-private')),
      false,
    );
  });

  it('blocks playlists only when neither modify scope was granted', () => {
    assert.equal(moduleBlockedByScopes('playlists', scopesFor('playlist-read-private')), true);
    assert.equal(
      moduleBlockedByScopes('playlists', scopesFor('playlist-read-collaborative playlist-read-private')),
      true,
    );
  });

  it('library needs user-library-modify; following needs user-follow-modify', () => {
    const readOnly = scopesFor('user-library-read user-follow-read');
    assert.equal(moduleBlockedByScopes('library', readOnly), true);
    assert.equal(moduleBlockedByScopes('following', readOnly), true);
    const write = scopesFor('user-library-modify user-follow-modify');
    assert.equal(moduleBlockedByScopes('library', write), false);
    assert.equal(moduleBlockedByScopes('following', write), false);
  });

  it('undefined granted scope blocks nothing (back-compat with pre-scope token files)', () => {
    const empty = scopesFor(undefined);
    for (const key of Object.keys(WRITE_SCOPE_REQUIREMENTS)) {
      assert.equal(moduleBlockedByScopes(key, empty), false, `${key} should stay visible`);
    }
  });

  it('never blocks read-only modules regardless of granted scopes', () => {
    const empty = scopesFor(undefined);
    const readOnly = scopesFor('user-read-private');
    for (const key of [
      'search',
      'catalog',
      'personalization',
      'users',
      'audiobooks',
      'resources',
      'prompts',
      'not-a-known-key',
    ]) {
      assert.equal(moduleBlockedByScopes(key, empty), false, key);
      assert.equal(moduleBlockedByScopes(key, readOnly), false, key);
    }
  });
});

describe('WRITE_SCOPE_REQUIREMENTS coverage', () => {
  it('documents exactly the four write-capable modules', () => {
    assert.deepEqual(Object.keys(WRITE_SCOPE_REQUIREMENTS).sort(), [
      'following',
      'library',
      'playback',
      'playlists',
    ]);
  });

  it('every requirement list is non-empty', () => {
    for (const [key, reqs] of Object.entries(WRITE_SCOPE_REQUIREMENTS)) {
      assert.ok(reqs.length > 0, `${key} has an empty requirement list`);
    }
  });
});
