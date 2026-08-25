import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOOLSETS, resolveToolsets, isActive, toolsetEnvHelp } from '../src/toolsets.js';

describe('TOOLSETS coverage', () => {
  it('covers every registration entry point in index.ts at least once', () => {
    // Registration keys as invoked in src/index.ts (registerXxx call sites
    // plus resources/prompts).
    const registrationKeys = [
      'playback',
      'search',
      'catalog',
      'personalization',
      'library',
      'following',
      'audiobooks',
      'playlists',
      'users',
      'resources',
      'prompts',
    ];
    const covered = new Set(Object.values(TOOLSETS).flat());
    for (const key of registrationKeys) {
      assert.ok(
        covered.has(key),
        `registration key '${key}' is not enabled by any toolset`,
      );
    }
  });
});

describe('resolveToolsets', () => {
  const allSets = new Set(Object.keys(TOOLSETS));

  it('defaults to every set for undefined', () => {
    assert.deepEqual(resolveToolsets(undefined).sets, allSets);
    assert.deepEqual(resolveToolsets(undefined).unknown, []);
  });

  it('defaults to every set for empty/whitespace specs', () => {
    for (const spec of ['', '   ', ',,,']) {
      const { sets, unknown } = resolveToolsets(spec);
      assert.deepEqual(sets, allSets, `spec: ${JSON.stringify(spec)}`);
      assert.deepEqual(unknown, []);
    }
  });

  it("'all' alone yields every set", () => {
    const { sets, unknown } = resolveToolsets('all');
    assert.deepEqual(sets, allSets);
    assert.deepEqual(unknown, []);
  });

  it("'all' mixed with subsets still yields every set", () => {
    const { sets, unknown } = resolveToolsets('catalog,all');
    assert.deepEqual(sets, allSets);
    assert.deepEqual(unknown, []);
  });

  it('parses an explicit subset', () => {
    const { sets, unknown } = resolveToolsets('playback,library');
    assert.deepEqual([...sets].sort(), ['library', 'playback']);
    assert.deepEqual(unknown, []);
  });

  it('trims whitespace and is case-insensitive', () => {
    const { sets, unknown } = resolveToolsets('  Playback , LIBRARY , Personalization ');
    assert.deepEqual([...sets].sort(), ['library', 'personalization', 'playback']);
    assert.deepEqual(unknown, []);
  });

  it('collects unknown names without throwing or activating anything', () => {
    const { sets, unknown } = resolveToolsets('catalog,bogus,nonsense');
    assert.deepEqual([...sets], ['catalog']);
    assert.deepEqual(unknown.sort(), ['bogus', 'nonsense']);
  });

  it('does not treat Object.prototype names as known sets', () => {
    const { sets, unknown } = resolveToolsets('constructor,toString,valueOf,playback');
    assert.deepEqual([...sets], ['playback']);
    // Tokens are lowercased during parsing, so unknown names come back
    // normalized.
    assert.deepEqual(unknown.sort(), ['constructor', 'tostring', 'valueof']);
  });
});

describe('isActive', () => {
  const sets = resolveToolsets('playback,catalog').sets;

  it('activates keys owned by an active set', () => {
    for (const key of ['playback', 'search', 'catalog', 'audiobooks']) {
      assert.equal(isActive(key, sets), true, key);
    }
  });

  it('deactivates keys owned only by inactive sets', () => {
    const allInactive = [
      'library',
      'following',
      'playlists',
      'users',
      'personalization',
      'resources',
      'prompts',
    ];
    for (const key of allInactive) {
      assert.equal(isActive(key, sets), false, key);
    }
  });

  it('never deactivates a key not owned by any set (defensive)', () => {
    assert.equal(isActive('some-future-entry-point', new Set()), true);
  });
});

describe('toolsetEnvHelp', () => {
  it('names every set on one line', () => {
    const line = toolsetEnvHelp();
    assert.equal(line.includes('\n'), false);
    for (const name of Object.keys(TOOLSETS)) {
      assert.ok(line.includes(name), `missing set '${name}'`);
    }
    assert.ok(line.includes('SPOTIFY_MCP_TOOLSETS'));
  });
});
