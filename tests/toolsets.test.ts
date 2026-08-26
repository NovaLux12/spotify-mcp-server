import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TOOLSETS,
  resolveToolsets,
  resolveToolOverrides,
  isActive,
  isModuleActive,
  toolsetEnvHelp,
} from '../src/toolsets.js';

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

describe('resolveToolOverrides', () => {
  it('parses enable/disable into key sets, ignoring empties', () => {
    const { enable, disable, unknown } = resolveToolOverrides(
      ' library , playback ,, ',
      'prompts',
    );
    assert.deepEqual([...enable].sort(), ['library', 'playback']);
    assert.deepEqual([...disable], ['prompts']);
    assert.deepEqual(unknown, { enable: [], disable: [] });
  });

  it('treats undefined/empty specs as no overrides', () => {
    const { enable, disable, unknown } = resolveToolOverrides(undefined, '');
    assert.equal(enable.size, 0);
    assert.equal(disable.size, 0);
    assert.deepEqual(unknown, { enable: [], disable: [] });
  });

  it('is case-insensitive and normalizes unknown names', () => {
    const { enable, disable, unknown } = resolveToolOverrides(
      'LIBRARY',
      'Bogus',
    );
    assert.deepEqual([...enable], ['library']);
    assert.deepEqual(unknown.enable, []);
    assert.deepEqual(unknown.disable, ['bogus']);
    assert.equal(disable.size, 0);
  });

  it('does not treat Object.prototype names as known keys', () => {
    const { enable, unknown } = resolveToolOverrides(
      'constructor,toString,personalization',
      undefined,
    );
    assert.deepEqual([...enable], ['personalization']);
    assert.deepEqual(unknown.enable.sort(), ['constructor', 'tostring']);
  });
});

describe('isModuleActive', () => {
  const sets = resolveToolsets('playback,catalog').sets;
  const noOverrides = resolveToolOverrides(undefined, undefined);

  it('force-enables a module whose set was trimmed', () => {
    assert.equal(isModuleActive('library', sets), false);
    const { enable } = resolveToolOverrides('library', undefined);
    assert.equal(isModuleActive('library', sets, { ...noOverrides, enable }), true);
  });

  it('force-disables a module whose set is active', () => {
    assert.equal(isModuleActive('search', sets), true);
    const { disable } = resolveToolOverrides(undefined, 'search');
    assert.equal(isModuleActive('search', sets, { ...noOverrides, disable }), false);
  });

  it('lets disable win over enable on the same key', () => {
    const { enable, disable } = resolveToolOverrides('catalog', 'catalog');
    assert.equal(isModuleActive('catalog', new Set(), { enable, disable }), false);
    // Even with the owning set active.
    assert.equal(isModuleActive('catalog', sets, { enable, disable }), false);
  });

  it('still force-disables a key not owned by any set (defensive)', () => {
    // Constructed directly: an unclassified key never parses as known, but
    // disable still wins over the always-active defensive default.
    const disable = new Set(['some-future-entry-point']);
    assert.equal(
      isModuleActive('some-future-entry-point', new Set(), { enable: new Set(), disable }),
      false,
    );
  });

  it('matches overrides case-insensitively against the raw key', () => {
    const { enable } = resolveToolOverrides('PERSONALIZATION', undefined);
    assert.equal(isModuleActive('personalization', new Set(), { enable, disable: new Set() }), true);
  });
});

describe('overrides combined with resolveToolsets output', () => {
  it('layers fine-grained opt-in on top of a trimmed toolset spec', () => {
    const { sets } = resolveToolsets('playback');
    const { enable, disable, unknown } = resolveToolOverrides(
      'personalization,library',
      'following',
    );
    const active = (key: string) => isModuleActive(key, sets, { enable, disable });
    // From the trimmed set:
    assert.equal(active('playback'), true);
    assert.equal(active('search'), false);
    // Force-enabled despite trimmed set:
    assert.equal(active('personalization'), true);
    assert.equal(active('library'), true);
    // Force-disabled even though just enabled via 'library':
    assert.equal(active('following'), false);
    // Unknown names surfaced for the caller to warn about:
    assert.deepEqual(unknown, { enable: [], disable: [] });
  });

  it('keeps isActive equivalent to isModuleActive without overrides', () => {
    const sets = resolveToolsets('playback,catalog,prompts').sets;
    for (const key of Object.values(TOOLSETS).flat()) {
      assert.equal(isActive(key, sets), isModuleActive(key, sets), key);
    }
  });
});
