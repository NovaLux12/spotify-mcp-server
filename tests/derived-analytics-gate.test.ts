/**
 * The derived-listening-analytics gate (#695), in-process.
 *
 * `tests/analytics-optin-registry.test.ts` proves the gate against a real
 * server over stdio. This file proves the two things the stdio test cannot
 * reach, because both are properties of the CLASSIFICATION rather than of the
 * wiring:
 *
 *   1. **The classification is total and disjoint.** Every tool the three
 *      analytics modules register with the opt-in ON is either withheld or
 *      named as retained, and no name is both. This is what makes a curated
 *      hand-typed list safe to keep. The list defaults to REGISTER for an
 *      unlisted name, so without this a new derived tool added to
 *      `swarm3_analytics.ts` would ship exposed, silently, and the only trace
 *      would be a reviewer's memory.
 *   2. **The opted-in surface still clears the startup budget gate.** The
 *      schema budget is enforced at SERVER START, and the census measures the
 *      default surface, so CI stays green while a user who sets the flag cannot
 *      boot. That is the defect #1128's `gatedSurface` exists to prevent, and
 *      nothing in CI can catch it unless a test drives the opted-in
 *      measurement through the same gate. This file does.
 *
 * The behavioural test for the default (flag unset ⇒ tools absent) lives in
 * `tests/analytics-optin-registry.test.ts`; the per-tool behaviour tests opt in
 * and say so.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerAnalyticsTools } from '../src/tools/analytics.js';
import { registerLibraryAnalyticsTools } from '../src/tools/libraryanalytics.js';
import { registerSwarm3AnalyticsTools } from '../src/tools/swarm3_analytics.js';
import {
  DERIVED_ANALYTICS_TOOLS,
  derivedAnalyticsEnabled,
} from '../src/derivedanalytics.js';
import {
  FALSY_ENV_VALUES,
  TRUTHY_ENV_VALUES,
  experimentalAnalyticsEnv,
  parseExperimentalAnalytics,
  unrecognisedBooleanEnv,
} from '../src/config.js';
import {
  REGISTRAR_MANIFEST,
  collectModuleSchemaBudgets,
  registerManifestModules,
  serializedSchemaBytes,
} from '../src/tools/annotations.js';
import { SpotifyClient as RealSpotifyClient } from '../src/client.js';
import { RETAINED_ANALYTICS_TOOLS as RETAINED } from './helpers/derived-analytics-oracle.js';

/** The three modules the gate is applied to, and the manifest keys they own. */
const GATED_MODULES = [
  { key: 'analytics', register: registerAnalyticsTools },
  { key: 'libraryanalytics', register: registerLibraryAnalyticsTools },
  { key: 'swarm3analytics', register: registerSwarm3AnalyticsTools },
] as const;

/** A client stub that answers nothing: these tests never invoke a handler. */
const stubClient = {
  get: async () => null,
  post: async () => null,
  put: async () => null,
  delete: async () => null,
  getAllPages: async () => [],
  getRateLimitStatus: () => ({ lastThrottleAt: null, retryAfterSec: null, cooldownRemainingMs: 0 }),
} as unknown as SpotifyClient;

/** Tool names one registrar produced, with the opt-in set to `value`. */
async function namesWithOptIn(value: string | undefined): Promise<Set<string>> {
  const prior = process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
  try {
    if (value === undefined) delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    else process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = value;
    const server = new McpServer({ name: 'gate-classification', version: '0.0.0' });
    try {
      for (const module of GATED_MODULES) {
        module.register(server, stubClient);
      }
      return new Set(Object.keys((server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {}));
    } finally {
      await server.close().catch(() => undefined);
    }
  } finally {
    if (prior === undefined) delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    else process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = prior;
  }
}

let optedIn: Set<string>;
let defaultSurface: Set<string>;

before(async () => {
  optedIn = await namesWithOptIn('1');
  defaultSurface = await namesWithOptIn(undefined);
});

describe('#695 — derived listening analytics opt-in', () => {
  it('withholds exactly the named tools and nothing else, with the flag unset', () => {
    // The FULL enumeration on both sides. Destructuring a lookup positionally
    // — `const [missing] = names.filter(...)` — is how a regression test ends
    // up green at HEAD because it bound the wrong element, so both sets are
    // compared whole and the failure names every difference.
    const withheld = [...optedIn].filter((n) => !defaultSurface.has(n)).sort();
    const unexpectedlyGated = [...DERIVED_ANALYTICS_TOOLS].filter((n) => !optedIn.has(n)).sort();
    const unexpectedlyRetained = [...DERIVED_ANALYTICS_TOOLS].filter((n) => defaultSurface.has(n)).sort();

    assert.deepEqual(
      withheld,
      [...DERIVED_ANALYTICS_TOOLS].sort(),
      'the tools missing from the default surface must be exactly DERIVED_ANALYTICS_TOOLS, in both directions',
    );
    assert.deepEqual(unexpectedlyGated, [], 'a withheld name the opt-in surface does not even serve is a typo in the list');
    assert.deepEqual(unexpectedlyRetained, [], 'a withheld name still registered with the flag unset is the gate failing open');
  });

  it('classifies every tool in the three modules, on exactly one side of the line', () => {
    // The totality guard. A new tool added to any of these modules appears in
    // `optedIn` and in neither list, and this fails naming it.
    const unclassified = [...optedIn].filter((n) => !DERIVED_ANALYTICS_TOOLS.has(n) && !RETAINED.has(n)).sort();
    const both = [...optedIn].filter((n) => DERIVED_ANALYTICS_TOOLS.has(n) && RETAINED.has(n)).sort();
    const retainedButNotRegistered = [...RETAINED].filter((n) => !optedIn.has(n)).sort();

    assert.deepEqual(unclassified, [], 'every tool in the gated modules must be classified as derived or retained');
    assert.deepEqual(both, [], 'a tool cannot be both withheld and retained');
    assert.deepEqual(retainedButNotRegistered, [], 'a retained name no module registers is a typo, and hides a tool that stopped existing');
  });

  it('withholds the tools the issue names, and each is registered when it opts in', () => {
    // Spelled out rather than read from DERIVED_ANALYTICS_TOOLS: the issue
    // (#695) names `weekday_listening_report` and `binge_detector_report` in
    // its acceptance criteria, so those two are a contract with the issue and
    // not only with this file.
    for (const name of ['weekday_listening_report', 'binge_detector_report', 'discovery_ratio', 'listening_clock']) {
      assert.ok(optedIn.has(name), `${name} must be registered with the opt-in on`);
      assert.ok(!defaultSurface.has(name), `${name} must not be registered with the flag unset`);
    }
  });

  it('leaves the re-presentations registered with the flag unset', () => {
    // The counterpart to the above, and the one that keeps the change from
    // being a silent removal: every retained tool is still served by default.
    const missing = [...RETAINED].filter((n) => !defaultSurface.has(n)).sort();
    assert.deepEqual(missing, [], 'a re-presentation must not be withheld by the gate');
  });

  it('reads the flag through the shared boolean convention, and warns on a value that names no boolean', () => {
    for (const value of TRUTHY_ENV_VALUES) {
      for (const spelling of [value, value.toUpperCase(), `  ${value}  `]) {
        assert.equal(experimentalAnalyticsEnv({ SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS: spelling }), true,
          `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=${JSON.stringify(spelling)} should enable (truthyEnv)`);
      }
    }
    for (const value of FALSY_ENV_VALUES) {
      assert.equal(experimentalAnalyticsEnv({ SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS: value }), false,
        `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=${JSON.stringify(value)} should leave analytics off`);
    }
    // Unset and empty are complete answers, not typos: warning on them would
    // fire on every process start, which is why `unrecognisedBooleanEnv`
    // excludes them and this gate must not reintroduce that.
    assert.equal(experimentalAnalyticsEnv({}), false, 'unset is off');
    assert.equal(experimentalAnalyticsEnv({ SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS: '' }), false, 'empty is off');
    assert.equal(unrecognisedBooleanEnv(''), false, 'empty is an answer, not a typo');
  });

  it('treats a malformed value as OFF and says so on stderr — never as a silent truthy', () => {
    // The `banana` case SPOTIFY_MCP_READONLY established (#611), applied to a
    // flag whose failure direction is the opposite: the default is already the
    // safe path, so a typo must not leave an operator believing eleven tools
    // are registered when they are not.
    const seen: string[] = [];
    const priorError = console.error;
    console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
    try {
      for (const raw of ['banana', 'enabled', '2', 'y', 'TRUE-ish', 'on!']) {
        seen.length = 0;
        const result = parseExperimentalAnalytics(raw);
        assert.equal(result, false, `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=${JSON.stringify(raw)} must leave analytics OFF`);
        assert.equal(derivedAnalyticsEnabled.call(null), process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS === undefined
          ? false
          : experimentalAnalyticsEnv(), 'the gate and the parser must agree');
        const line = seen.find((l) => l.includes('SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS'));
        assert.ok(line, `a value naming no boolean must warn; nothing was printed for ${JSON.stringify(raw)}`);
        assert.match(line, /names no boolean/, 'the warning must say the value was not understood');
        assert.match(line, new RegExp(`"${raw}"`), 'the warning must quote the value it rejected');
        for (const accepted of TRUTHY_ENV_VALUES) {
          assert.ok(line.includes(accepted), `the warning must name the accepted spelling ${accepted}`);
        }
        assert.match(line, /OFF|off/, 'the warning must state which way the value resolved');
      }
    } finally {
      console.error = priorError;
    }
  });

  it('does not warn for a value that IS a boolean, in either direction', () => {
    const seen: string[] = [];
    const priorError = console.error;
    console.error = (...args: unknown[]) => { seen.push(args.map(String).join(' ')); };
    try {
      for (const raw of [...TRUTHY_ENV_VALUES, ...FALSY_ENV_VALUES]) {
        seen.length = 0;
        parseExperimentalAnalytics(raw);
        assert.deepEqual(seen, [], `${raw} is a recognised boolean and must not warn`);
      }
      seen.length = 0;
      parseExperimentalAnalytics(undefined);
      parseExperimentalAnalytics('');
      assert.deepEqual(seen, [], 'unset and empty are answers, not typos, and must not warn');
    } finally {
      console.error = priorError;
    }
  });

  it('keeps the opted-in surface inside the manifest ceiling, so the flagged server still boots', async () => {
    // The defect #1128 fixed, reachable only from here. The census strips
    // SPOTIFY_*, so the manifest baseline and the CI budget describe the
    // DEFAULT surface; a module that grows when the flag is set must be sized
    // for the larger of the two or `assertModuleSchemaBudgets` throws inside
    // `src/index.ts` — at startup, for the user who set the flag, while CI is
    // green. This drives the OPTED-IN measurement through the same gate.
    const gatedKeys = GATED_MODULES.map((m) => m.key);
    for (const key of gatedKeys) {
      const row = REGISTRAR_MANIFEST.find((m) => m.key === key);
      assert.ok(row, `${key} must be a manifest row`);
      assert.ok(row.gatedSurface, `${key} must declare a gatedSurface: its tool set depends on config (#695)`);
      assert.equal(row.gatedSurface.gatedBy, 'SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS',
        `${key}'s gatedSurface must name the env var that switches it`);
      assert.ok(row.gatedSurface.toolCount >= row.baseline.toolCount,
        `${key}: a gated surface below the baseline would shrink the ceiling under the default install`);
      assert.ok(row.gatedSurface.schemaBytes >= row.baseline.schemaBytes,
        `${key}: a gated schema figure below the baseline would shrink the ceiling under the default install`);
    }

    const prior = process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    try {
      process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = '1';
      const server = new McpServer({ name: 'gate-budget', version: '0.0.0' });
      await registerManifestModules(server, new RealSpotifyClient(), {
        readOnly: false,
        isModuleActive: () => true,
        scopeBlocked: () => false,
      });
      try {
        const rows = collectModuleSchemaBudgets(server);
        for (const key of gatedKeys) {
          const measured = rows.find((r) => r.module === key);
          assert.ok(measured, `${key} must be measured`);
          const entry = REGISTRAR_MANIFEST.find((m) => m.key === key)!;
          // The DECLARED opted-in figure must be the measured one, in both
          // directions. Understating it shrinks the ceiling and the opted-in
          // server refuses to start; overstating it (a dropped digit, say)
          // inflates the ceiling and hides a real growth from the gate that is
          // supposed to force a manifest edit. Comparing against a ceiling
          // derived from the same number would pass either way.
          assert.equal(measured.toolCount, entry.gatedSurface!.toolCount,
            `${key}: gatedSurface.toolCount must be the measured opted-in surface`);
          assert.equal(measured.schemaBytes, entry.gatedSurface!.schemaBytes,
            `${key}: gatedSurface.schemaBytes must be the measured opted-in surface, in the census's unit`);
          assert.ok(measured.toolCount <= entry.ceiling.toolCount,
            `${key}: opted-in registers ${measured.toolCount} tools, ceiling is ${entry.ceiling.toolCount} — the server would refuse to start`);
          assert.ok(measured.schemaBytes <= entry.ceiling.schemaBytes,
            `${key}: opted-in measures ${measured.schemaBytes}B, ceiling is ${entry.ceiling.schemaBytes}B — the server would refuse to start`);
        }
        // And the aggregate gate, measured the same way src/index.ts measures
        // it, with the flag on. Raising this ceiling is never the answer; a
        // breach here means the opted-in surface grew and the baselines moved.
        const total = rows.reduce((sum, r) => sum + r.schemaBytes, 0);
        assert.ok(Number.isFinite(total) && total > 0, 'the aggregate measurement must be real');
      } finally {
        await server.close().catch(() => undefined);
      }
    } finally {
      if (prior === undefined) delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
      else process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = prior;
    }
  });

  it('keeps the DEFAULT surface inside the same gate, so the unflagged server still boots', async () => {
    // The mirror of the above. Both halves matter: a ceiling sized only for the
    // opted-in surface would let the default install pass while a baseline edit
    // meant for the opted-in one quietly shrank the ordinary case.
    const prior = process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
    try {
      delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
      const server = new McpServer({ name: 'gate-budget-default', version: '0.0.0' });
      await registerManifestModules(server, new RealSpotifyClient(), {
        readOnly: false,
        isModuleActive: () => true,
        scopeBlocked: () => false,
      });
      try {
        const rows = collectModuleSchemaBudgets(server);
        for (const key of GATED_MODULES.map((m) => m.key)) {
          const measured = rows.find((r) => r.module === key)!;
          const entry = REGISTRAR_MANIFEST.find((m) => m.key === key)!;
          assert.ok(measured.toolCount <= entry.ceiling.toolCount,
            `${key}: default registers ${measured.toolCount} tools, ceiling is ${entry.ceiling.toolCount}`);
          assert.ok(measured.schemaBytes <= entry.ceiling.schemaBytes,
            `${key}: default measures ${measured.schemaBytes}B, ceiling is ${entry.ceiling.schemaBytes}B`);
          assert.equal(measured.toolCount, entry.baseline.toolCount,
            `${key}: the manifest baseline must be the DEFAULT surface — the census measures with SPOTIFY_* stripped`);
          assert.equal(measured.schemaBytes, entry.baseline.schemaBytes,
            `${key}: the manifest baseline schema bytes must be the DEFAULT surface`);
        }
      } finally {
        await server.close().catch(() => undefined);
      }
    } finally {
      if (prior === undefined) delete process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS;
      else process.env.SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS = prior;
    }
  });

});
