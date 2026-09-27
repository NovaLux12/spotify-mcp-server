import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TOOLSETS,
  assertToolsetsUsable,
  resolveToolsets,
  resolveToolOverrides,
  isModuleActive,
  toolsetEnvHelp,
} from '../src/toolsets.js';
import { REGISTRAR_MANIFEST, type RegistrarManifestEntry } from '../src/tools/annotations.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_TS = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');

/**
 * Registration keys `src/index.ts` gates with a string literal (#669). The
 * registrar-manifest loop hands `isModuleActive` a *variable*
 * (`isModuleActive: (key) => isModuleActive(key, ...)`), so it is deliberately
 * not matched here: REGISTRAR_MANIFEST is the source of truth for that half,
 * and this scan is its complement for the hand-gated surfaces
 * (resources/prompts) that never reach the manifest.
 *
 * Scanned, not transcribed. A second hand-kept list of key names is exactly
 * the failure this replaces — it silently stops covering whatever the source
 * grows next. Comments are stripped first so a key quoted in prose about the
 * gate is not mistaken for the gate itself.
 */
function indexEntryPointKeys(source: string): string[] {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  return [...code.matchAll(/\bisModuleActive\(\s*'([a-z0-9_-]+)'/g)].map((match) => match[1]!);
}

/** Registration keys the manifest declares as registering unconditionally. */
function ungatedManifestKeys(manifest: readonly RegistrarManifestEntry[]): string[] {
  return [...new Set(manifest.filter((m) => m.alwaysActive === true).map((m) => m.registrationKey))].sort();
}

/**
 * Every registration entry point that `SPOTIFY_MCP_TOOLSETS` is supposed to be
 * able to turn off: each manifest module that is not `alwaysActive`, plus each
 * hand-gated literal in index.ts.
 */
function gatedRegistrationKeys(
  manifest: readonly RegistrarManifestEntry[] = REGISTRAR_MANIFEST,
  indexSource: string = INDEX_TS,
): string[] {
  return [
    ...new Set([
      ...manifest.filter((m) => m.alwaysActive !== true).map((m) => m.registrationKey),
      ...indexEntryPointKeys(indexSource),
    ]),
  ].sort();
}

/**
 * Parity between the registration entry points and the TOOLSETS map, reported
 * as messages that NAME the offending key. Empty when parity holds.
 *
 * Both directions matter. A gated entry point that no set owns is silently
 * always-on — `isModuleActive` returns `true` for a key missing from
 * `KEY_TO_SETS`, so a host trimming for a tool-count cap cannot turn it off
 * and `toolset_report` never shows it. A TOOLSETS key that gates nothing is
 * dead trim vocabulary that reports success while changing nothing
 * (#468/#485).
 */
function toolsetParityProblems(
  toolsets: Record<string, readonly string[]> = TOOLSETS,
  manifest: readonly RegistrarManifestEntry[] = REGISTRAR_MANIFEST,
  indexSource: string = INDEX_TS,
): string[] {
  const problems: string[] = [];
  const owned = new Set(Object.values(toolsets).flat());
  const gated = new Set(gatedRegistrationKeys(manifest, indexSource));
  // An `alwaysActive` manifest module is exempt from the orphan rule because a
  // toolset cannot gate it — the flag, not a kept name, is what says so.
  const ungated = new Set(ungatedManifestKeys(manifest));

  for (const [set, keys] of Object.entries(toolsets)) {
    if (keys.length === 0) problems.push(`toolset '${set}' enables no registration key`);
  }
  for (const key of [...gated].sort()) {
    if (!owned.has(key)) {
      problems.push(
        `registration entry point '${key}' is owned by no toolset, so SPOTIFY_MCP_TOOLSETS cannot turn it off`,
      );
    }
  }
  for (const key of [...owned].sort()) {
    if (!gated.has(key) && !ungated.has(key)) {
      problems.push(`toolset key '${key}' gates no registration entry point`);
    }
  }
  return problems;
}

describe('toolset parity is derived, not hand-listed (#669)', () => {
  it('reads entry-point keys out of the source instead of a kept list', () => {
    // The derivation, proven on text that is not the shipped source: a key
    // invented here is picked up, the manifest loop's variable argument is
    // not, and a key the source never mentions does not appear.
    assert.deepEqual(
      indexEntryPointKeys("if (isModuleActive('brandnewmodule', sets, ov)) register();"),
      ['brandnewmodule'],
    );
    assert.deepEqual(
      indexEntryPointKeys("isModuleActive: (key) => isModuleActive(key, activeSets, overrides),"),
      [],
      'the manifest loop passes a variable; REGISTRAR_MANIFEST covers it',
    );
    assert.deepEqual(indexEntryPointKeys('// nothing gated here'), []);
    assert.deepEqual(
      indexEntryPointKeys("// see isModuleActive('proseonly') for the gate"),
      [],
      'a key named in a comment is not a gate',
    );
    assert.ok(
      indexEntryPointKeys(INDEX_TS).length > 0,
      'src/index.ts gates resources/prompts by literal; a zero result means the scan broke',
    );
  });

  it('has no parity problem in the shipped source', () => {
    assert.deepEqual(toolsetParityProblems(), []);
  });

  it('fails when a registration entry point has no toolset', () => {
    // The acceptance case from #669: a new gate in index.ts with no TOOLSETS
    // entry. `isModuleActive` defaults such a key to active, so nothing else
    // in the suite notices — the module is always-on and invisible.
    const withNewModule = `${INDEX_TS}\nif (isModuleActive('newmodule', activeSets, overrides)) register();\n`;
    const problems = toolsetParityProblems(TOOLSETS, REGISTRAR_MANIFEST, withNewModule);
    assert.ok(
      problems.includes(
        "registration entry point 'newmodule' is owned by no toolset, so SPOTIFY_MCP_TOOLSETS cannot turn it off",
      ),
      `expected newmodule to be reported, got: ${problems.join('; ') || '(none)'}`,
    );
  });

  it('fails when a manifest module is added with an unowned registration key', () => {
    const added: RegistrarManifestEntry = {
      ...REGISTRAR_MANIFEST[0]!,
      key: 'newmodule',
      registrationKey: 'newmodule',
    };
    const problems = toolsetParityProblems(TOOLSETS, [...REGISTRAR_MANIFEST, added], INDEX_TS);
    assert.ok(
      problems.some((problem) => problem.includes("'newmodule'")),
      `expected newmodule to be reported, got: ${problems.join('; ') || '(none)'}`,
    );
  });

  it('fails when a toolset key gates nothing', () => {
    // Scoped to the injected key: a genuine break in the shipped source is
    // reported by the parity test above, not smuggled in here.
    const problems = toolsetParityProblems({ ...TOOLSETS, legacy: ['swarm9legacy'] });
    assert.ok(
      problems.includes("toolset key 'swarm9legacy' gates no registration entry point"),
      `expected swarm9legacy to be reported, got: ${problems.join('; ') || '(none)'}`,
    );
  });

  it('fails when a toolset is empty', () => {
    const problems = toolsetParityProblems({ ...TOOLSETS, hollow: [] });
    assert.ok(
      problems.includes("toolset 'hollow' enables no registration key"),
      `expected hollow to be reported, got: ${problems.join('; ') || '(none)'}`,
    );
  });

  it('derives the alwaysActive exemption from the manifest flag, not a name list', () => {
    // `swarm3meta` is the one key TOOLSETS names that no gate can act on,
    // because its manifest entry is alwaysActive. That exemption is the flag:
    // dropping the module from the manifest makes the key a dead orphan the
    // check must catch, and clearing the flag moves it into the gated set.
    assert.ok(new Set(Object.values(TOOLSETS).flat()).has('swarm3meta'), 'premise: the key is in a toolset');
    assert.ok(ungatedManifestKeys(REGISTRAR_MANIFEST).includes('swarm3meta'), 'premise: the flag is why');
    assert.ok(
      toolsetParityProblems(TOOLSETS, REGISTRAR_MANIFEST.filter((m) => m.key !== 'swarm3meta')).includes(
        "toolset key 'swarm3meta' gates no registration entry point",
      ),
      'removing the manifest entry must orphan the key',
    );
    assert.ok(
      gatedRegistrationKeys(
        REGISTRAR_MANIFEST.map((m) => (m.key === 'swarm3meta' ? { ...m, alwaysActive: false } : m)),
      ).includes('swarm3meta'),
      'clearing alwaysActive must move the key into the gated set',
    );
  });

  it('keeps the non-manifest index.ts surfaces explicitly gated', () => {
    // resources/prompts never reach the manifest, so their only claim on a
    // toolset is the literal gate in index.ts.
    for (const key of indexEntryPointKeys(INDEX_TS)) {
      assert.ok(
        new Set(Object.values(TOOLSETS).flat()).has(key),
        `index.ts gates '${key}' but no toolset owns it`,
      );
    }
  });
});

describe('TOOLSETS coverage', () => {
  it('defines every module exactly once with a positive baseline and ceiling', () => {
    assert.equal(new Set(REGISTRAR_MANIFEST.map((module) => module.key)).size, REGISTRAR_MANIFEST.length);
    for (const module of REGISTRAR_MANIFEST) {
      assert.ok(module.ceiling.toolCount >= module.baseline.toolCount, module.key);
      assert.ok(module.ceiling.schemaBytes >= module.baseline.schemaBytes, module.key);
    }
  });

  it('defines every module exactly once with a positive baseline and ceiling', () => {
    assert.equal(new Set(REGISTRAR_MANIFEST.map((module) => module.key)).size, REGISTRAR_MANIFEST.length);
    for (const module of REGISTRAR_MANIFEST) {
      assert.ok(module.ceiling.toolCount >= module.baseline.toolCount, module.key);
      assert.ok(module.ceiling.schemaBytes >= module.baseline.schemaBytes, module.key);
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

  it('yields empty sets for an unknown-only spec', () => {
    const { sets, unknown } = resolveToolsets('bogus_set');
    assert.equal(sets.size, 0);
    assert.deepEqual(unknown, ['bogus_set']);
  });

  it('does not treat Object.prototype names as known sets', () => {
    const { sets, unknown } = resolveToolsets('constructor,toString,valueOf,playback');
    assert.deepEqual([...sets], ['playback']);
    // Tokens are lowercased during parsing, so unknown names come back
    // normalized.
    assert.deepEqual(unknown.sort(), ['constructor', 'tostring', 'valueof']);
  });
});

// #581 deleted the `isActive` alias, which was set membership with no
// overrides and had no production caller. These cases assert that behaviour
// against the function that is actually called now, with overrides omitted —
// so the coverage of the semantics survives the deletion.
describe('isModuleActive set membership, with no overrides', () => {
  const sets = resolveToolsets('playback,catalog').sets;

  it('activates keys owned by an active set', () => {
    for (const key of ['playback', 'search', 'catalog', 'audiobooks']) {
      assert.equal(isModuleActive(key, sets), true, key);
    }
  });

  it('keeps scenes active through the playback key for default and trimmed specs', () => {
    for (const spec of [undefined, '  Playback  ']) {
      const { sets, unknown } = resolveToolsets(spec);
      assert.equal(isModuleActive('playback', sets), true, `spec: ${JSON.stringify(spec)}`);
      assert.deepEqual(unknown, []);
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
      assert.equal(isModuleActive(key, sets), false, key);
    }
  });

  it('never deactivates a key not owned by any set (defensive)', () => {
    assert.equal(isModuleActive('some-future-entry-point', new Set()), true);
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

  it('omitting overrides is the same as passing empty ones, for every key', () => {
    // The two-argument form is what the remaining set-membership cases use
    // now that the `isActive` alias is gone (#581). Pinned against empty
    // override sets so the optional argument cannot start applying something
    // callers did not ask for.
    const sets = resolveToolsets('playback,catalog,prompts').sets;
    const empty = { enable: new Set<string>(), disable: new Set<string>() };
    for (const key of Object.values(TOOLSETS).flat()) {
      assert.equal(isModuleActive(key, sets), isModuleActive(key, sets, empty), key);
    }
  });
});

describe('assertToolsetsUsable', () => {
  it('throws naming valid sets for an unknown-only spec', () => {
    const resolved = resolveToolsets('bogus_set');
    assert.throws(
      () => assertToolsetsUsable('bogus_set', resolved),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const name of Object.keys(TOOLSETS)) {
          assert.ok(err.message.includes(name), `missing set '${name}'`);
        }
        assert.ok(err.message.includes('bogus_set'));
        return true;
      },
    );
  });

  it('stays non-fatal for empty/unset/whitespace/all specs', () => {
    for (const spec of [undefined, '', '   ', ',,,', 'all', 'catalog,all']) {
      assert.doesNotThrow(() => assertToolsetsUsable(spec, resolveToolsets(spec)), `spec: ${JSON.stringify(spec)}`);
    }
  });

  it('resolves fine for mixed known+unknown specs', () => {
    const resolved = resolveToolsets('playback,bogus_set');
    assert.doesNotThrow(() => assertToolsetsUsable('playback,bogus_set', resolved));
    assert.deepEqual([...resolved.sets], ['playback']);
    assert.deepEqual(resolved.unknown, ['bogus_set']);
  });

  it('states the unknown-only/mixed rule in toolsetEnvHelp', () => {
    const line = toolsetEnvHelp();
    assert.ok(line.includes('Unknown-only'), 'missing unknown-only rule');
    assert.ok(line.toLowerCase().includes('mixed'), 'missing mixed rule');
  });
});

describe('the no-overrides alias stays deleted (#581)', () => {
  /**
   * `isActive(key, sets)` was set membership with overrides silently dropped.
   * It had no production caller left once the doctor resolved overrides and
   * passed them (#581), and an alias that answers "is this module active?"
   * while ignoring `SPOTIFY_MCP_ENABLE_TOOLS`/`SPOTIFY_MCP_DISABLE_TOOLS` is
   * precisely the kind of second answer that issue was opened about — a
   * doctor that consulted it would report a scope gap for a module the
   * registry had hidden. Pinned here because the acceptance criterion was a
   * grep, and a grep is not a gate.
   */
  it('src/toolsets.ts declares no isActive export', () => {
    const source = readFileSync(join(ROOT, 'src', 'toolsets.ts'), 'utf8');
    assert.doesNotMatch(
      source,
      /export function isActive\b/,
      'the no-overrides alias is back; call isModuleActive with the resolved overrides instead',
    );
    // The doc comment that pointed at it too, so a reader following the
    // reference does not go looking for a function that is not there.
    assert.doesNotMatch(source, /\{@link isActive\}/, 'a stale @link to the deleted alias');
  });

  it('no module under src/ calls it', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        // Code only. `src/toolsets.ts` documents the alias in prose — naming
        // what was deleted and why — and a doc comment is not a call site.
        // `isModuleActive` is blanked too, so the real function and any
        // prefix match on it cannot trip this.
        const text = readFileSync(full, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, ' ')
          .replace(/^[ \t]*\/\/.*$/gm, ' ')
          .replace(/isModuleActive/g, '');
        if (/(?<![A-Za-z0-9_])isActive\s*\(/.test(text)) offenders.push(relative(ROOT, full));
      }
    };
    walk(join(ROOT, 'src'));
    assert.deepEqual(offenders, [], `these modules call the deleted alias: ${offenders.join(', ')}`);
  });
});
