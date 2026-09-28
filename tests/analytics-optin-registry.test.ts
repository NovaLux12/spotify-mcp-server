/**
 * The derived-listening-analytics opt-in against a REAL server process (#695).
 *
 * `tests/derived-analytics-gate.test.ts` proves the classification and the
 * budget in-process. This file proves the parts that only exist in the shipped
 * wiring: what a host actually receives in `tools/list`, and what the operator
 * is told on stderr.
 *
 * The stdio harness matters here for a specific reason. The alternative —
 * calling the registrars in-process — cannot see the startup disclosure, and a
 * gate whose whole job is to be conspicuous when it is closed is not
 * demonstrated by asserting only on the array it filters. The stderr line is
 * the user-facing half of the change, so it is read from the child's own
 * stderr, not reconstructed from the code that writes it.
 *
 * One server boot per distinct environment, cached: the census measured a boot
 * at ~2.1 s and a full-suite run boots many servers, so re-spawning per
 * assertion would spend the box's budget on repetition. The environment is
 * stripped of the developer's own `SPOTIFY_*` by `hermeticServerEnv`, or a
 * result would depend on whether the person running it exported the flag.
 */
import './helpers/hermetic.js';

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { StdioJsonRpcChild, hermeticServerEnv } from './helpers/stdio-child.js';
import { armFileDeadline, FLEET_FILE_BUDGET_MS } from './helpers/file-deadline.js';

const REPO_ROOT = join(import.meta.dirname, '..');

interface Surface {
  tools: string[];
  stderr: string;
}

const cache = new Map<string, Promise<Surface>>();

async function surfaceWith(
  flag: string | undefined,
  extra: Readonly<Record<string, string | undefined>> = {},
): Promise<Surface> {
  const key = JSON.stringify([flag ?? null, extra]);
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<Surface> => {
    const { env, home } = hermeticServerEnv(
      // `SPOTIFY_MCP_TOOLSETS=all` on BOTH sides of every comparison in this
      // file, for the same reason as the other registry tests: what is under
      // test here is the analytics flag, not the toolset trim, and since #889
      // an unset `SPOTIFY_MCP_TOOLSETS` registers a strict subset — so the
      // flag-off baseline would be missing most of the tools the flag-on side
      // adds, and "the opt-in adds exactly the withheld tools" would be
      // asserting the toolset default instead. A caller's own
      // SPOTIFY_MCP_TOOLSETS still wins: the spread order is unchanged.
      { SPOTIFY_MCP_TOOLSETS: 'all', SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS: flag, ...extra },
      `optin-${key.replace(/\W+/g, '-')}`,
    );
    // A real token file, as `scripts/surface-census.mjs` also writes one.
    // Without it the scope filter withholds the modules whose grant is
    // missing, and the write-tool half of the independence case below would
    // fail for a reason that has nothing to do with the gate under test — the
    // child would look like a read-only server by accident rather than by
    // configuration. The token is a placeholder: nothing here makes a request.
    const tokenFile = join(home, 'tokens.json');
    writeFileSync(tokenFile, JSON.stringify({
      access_token: 'analytics-optin-test',
      refresh_token: 'analytics-optin-test',
      expires_at: Date.now() + 60 * 60 * 1000,
    }), { mode: 0o600 });
    env.SPOTIFY_MCP_TOKEN_FILE = tokenFile;

    const child = StdioJsonRpcChild.spawn({
      label: `analytics-optin ${key}`,
      command: 'node',
      args: ['--import', 'tsx/esm', 'src/index.ts'],
      cwd: REPO_ROOT,
      env,
    });
    try {
      await child.initialize('analytics-optin-test');
      const tools = await child.toolNames();
      return { tools, stderr: child.stderr };
    } finally {
      await child.dispose();
    }
  })();
  cache.set(key, promise);
  return promise;
}

/**
 * The whole-file bound (#1569).
 *
 * This file spawns real child processes, so a child whose tree still holds an
 * inherited stdio write end can keep this process's `PipeWrap` registered and the
 * loop undrainable — the #1365 failure, which is silent and unbounded because the
 * runner is invoked with no `--test-timeout`. See `helpers/file-deadline.ts`.
 *
 * Armed at module scope, above every hook, because a bound a teardown can clear is
 * not a bound. The timer is `unref`'d, so it cannot itself delay this file.
 */
armFileDeadline({
  label: 'tests/analytics-optin-registry.test.ts',
  budgetMs: FLEET_FILE_BUDGET_MS,
  children: () => [],
});

after(async () => {
  // Nothing to reap — `dispose()` is awaited inside each boot — but draining
  // the cache means a rejection surfaces here rather than as an unhandled one
  // after the file has reported success.
  await Promise.allSettled([...cache.values()]);
});

describe('#695 — the analytics opt-in on a real server', () => {
  it('does not serve the derived tools when the flag is unset', async () => {
    const { tools } = await surfaceWith(undefined);
    const present = tools.filter((name) => DERIVED.includes(name));
    assert.deepEqual(present, [], 'no derived listening-analytics tool may reach tools/list with the flag unset');
  });

  it('serves every derived tool when the flag is 1, alongside the re-presentations', async () => {
    const withFlag = new Set((await surfaceWith('1')).tools);
    const without = new Set((await surfaceWith(undefined)).tools);
    const missing = DERIVED.filter((name) => !withFlag.has(name));
    assert.deepEqual(missing, [], 'the opt-in must register every withheld tool');

    // The opt-in ADDS the derived tools and changes nothing else. An exact set
    // difference in both directions, not a spot check: a gate that also dropped
    // a re-presentation would pass a "contains" assertion.
    const added = [...withFlag].filter((n) => !without.has(n)).sort();
    const removed = [...without].filter((n) => !withFlag.has(n)).sort();
    assert.deepEqual(added, [...DERIVED].sort(), 'the opt-in must add exactly the withheld tools');
    assert.deepEqual(removed, [], 'the opt-in must not remove anything the default serves');
  });

  it('treats a value that names no boolean as OFF, and says so', async () => {
    const banana = await surfaceWith('banana');
    const off = await surfaceWith(undefined);
    assert.deepEqual(
      banana.tools.filter((n) => DERIVED.includes(n)),
      [],
      'an unrecognised value must not read as true — the default is the safe path',
    );
    assert.deepEqual([...banana.tools].sort(), [...off.tools].sort(),
      'a malformed value must produce the same surface as leaving it unset, not merely a similar one');
    assert.match(
      banana.stderr,
      /SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS "banana" names no boolean/,
      'the malformed value must be named on stderr, not swallowed',
    );
    assert.match(banana.stderr, /stay OFF/, 'the warning must state which way the value resolved');
  });

  it('names the flag on stderr in BOTH directions, so a closed gate is never silent', async () => {
    // The failure this guards: an operator who sets a typo'd value and reads
    // only the tool list concludes eleven tools were removed in a release. The
    // line below is the whole disclosure, so it is asserted for the ON case
    // too — a host that opted in should be able to see in a log that the extra
    // surface is what it asked for.
    const off = await surfaceWith(undefined);
    assert.match(off.stderr, /derived listening analytics are OFF/,
      'with the flag unset the server must say the analytics are off');
    assert.match(off.stderr, /SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=1/,
      'the OFF line must name the variable and the value that changes it');
    for (const name of DERIVED) {
      assert.ok(off.stderr.includes(name), `the OFF line must name ${name}, or an operator cannot tell what is missing`);
    }

    const on = await surfaceWith('1');
    assert.match(on.stderr, /SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS is set/,
      'with the flag set the server must say the analytics are registered');
  });

  it('accepts every spelling the shared boolean convention reads as true', async () => {
    // `truthyEnv` is the single parser, so the gate cannot disagree with the
    // rest of the config surface about what a boolean is. Asserted on the
    // server rather than the parser alone, because the wiring is the part that
    // could bypass it.
    for (const value of ['true', 'yes', 'on', 'ON', '  1  ']) {
      const { tools } = await surfaceWith(value);
      const missing = DERIVED.filter((name) => !tools.includes(name));
      assert.deepEqual(missing, [], `SPOTIFY_MCP_EXPERIMENTAL_ANALYTICS=${JSON.stringify(value)} should register the derived tools`);
    }
  });

  it('leaves the read-only gate independent — the two switches neither imply nor report each other', async () => {
    // SPOTIFY_MCP_READONLY hides write-capable MODULES; this gate hides
    // individual read-only TOOLS. Conflating them would either weaken the
    // read-only guarantee or hide analytics behind a safety flag that has
    // nothing to do with policy. Both combinations are checked so the
    // independence is a measured fact rather than an intention.
    const readOnlyOn = await surfaceWith(undefined, { SPOTIFY_MCP_READONLY: '1' });
    const readOnlyAnalytics = await surfaceWith('1', { SPOTIFY_MCP_READONLY: '1' });
    const plain = await surfaceWith(undefined);
    const plainAnalytics = await surfaceWith('1');

    // Read-only does not decide analytics: a read-only server still withholds
    // them, and the difference between the two is exactly the gate's doing.
    assert.deepEqual(
      readOnlyOn.tools.filter((n) => DERIVED.includes(n)),
      [],
      'a read-only server must not serve derived analytics by default',
    );
    assert.deepEqual(
      readOnlyAnalytics.tools.filter((n) => DERIVED.includes(n)).sort(),
      plainAnalytics.tools.filter((n) => DERIVED.includes(n)).sort(),
      'SPOTIFY_MCP_READONLY must not change which derived analytics are registered, in either direction',
    );
    // READONLY does remove write tools — that is its job, and asserting the
    // whole surfaces match would be asserting it does NOT. What must hold is
    // that the write half moved and the read half did not.
    assert.ok(!readOnlyAnalytics.tools.includes('save_to_library'),
      'the baseline read-only guarantee must still hold with the analytics opt-in set');
    assert.ok(!readOnlyOn.tools.includes('save_to_library'),
      'and with the flag unset — the opt-in must not be what hides the write surface');
    // And the analytics flag must not remove a write tool: the opt-in is not a
    // read-only switch in disguise.
    const writable = ['save_to_library', 'remove_from_library', 'add_to_playlist'];
    for (const name of writable) {
      assert.ok(plainAnalytics.tools.includes(name), `the analytics opt-in must not hide the write tool ${name}`);
    }
    assert.ok(plain.tools.includes('save_to_library'),
      'the default server must still be writable, so the analytics opt-in is not what decides the write surface');
  });
});

/**
 * The withheld set, spelled out rather than imported from
 * `src/derivedanalytics.ts`.
 *
 * A test that reads its expectation out of the same constant it is checking
 * cannot fail: if the gate stopped withholding `binge_detector_report` and the
 * list lost it too, the assertion would compare the list against itself and
 * pass. This copy is the independent statement of what the issue asked for.
 * `tests/derived-analytics-gate.test.ts` is the half that keeps the two in
 * step, by asserting the source list and this one partition the same
 * enumeration.
 */
const DERIVED: readonly string[] = [
  'artist_listening_clock',
  'binge_detector_report',
  'discovery_ratio',
  'listening_clock',
  'listening_clock_heatmap',
  'listening_heatmap',
  'listening_recap_brief',
  'listening_report',
  'mood_bucket_report',
  'weekday_listening_report',
  'weekly_rotation_report',
];
