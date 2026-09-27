/**
 * #848 — the collapse of the transfer and volume tool families onto
 * `transfer_playback` and `set_volume`.
 *
 * ## What this file is for
 *
 * Ten tool names went away: three transfer tools (`handoff`, `switch_device`,
 * `transfer_playback_with_state`) and seven volume writers (`volume_step`,
 * `mute`, `unmute`, `room_level`, `apply_device_presets`, `apply_volume_plan`,
 * `plan_volume_level_across_devices`). Each still FORWARDS for one release with
 * its arguments translated, and the issue's acceptance criteria call for the
 * forwarding to be asserted by name.
 *
 * The cases come in two kinds, and the split is deliberate:
 *
 * - **Forwarding** goes through the real `installToolErrorBoundary`, the path a
 *   host takes. Each case asserts the SURVIVOR's schema accepted the rewritten
 *   arguments and then that the wire calls are the ones the retired tool used to
 *   make — because a rewriter that mistranslated a flag would be caught by that
 *   schema, and one that dropped a flag would not.
 * - **Behaviour** that moved modules (the mute memory, the room-level copy, the
 *   full-state transfer) is driven against the survivor directly. Those cases
 *   used to live in `tools.exhaust2playback.test.ts`,
 *   `tools.playbackext.test.ts` and `tools.swarm3playback-executing.test.ts`;
 *   they moved here because the tools they cover are no longer in those
 *   modules' registrars.
 *
 * ## Why the resolver is pinned by precedence, not by example
 *
 * Three copies of `resolveDeviceHint` existed and they had drifted: exhaust2's
 * consulted the sidecar label, the other two did not; scenes' matched names
 * case-insensitively, playbackintel's did not. Collapsing the tools without
 * collapsing the resolver would have picked one of the three behaviours
 * arbitrarily, so the order — id, then label, then case-insensitive name
 * substring — is asserted step by step rather than through one happy path that
 * all three steps would satisfy.
 *
 * ## Environment
 *
 * Both sidecars the volume family reads are redirected under `mkdtemp`, and
 * `tests/helpers/hermetic.js` moves `$HOME` so nothing can reach a real
 * `~/.spotify-mcp`. No test here binds a port.
 */
import './helpers/hermetic.js';

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { StubSpotifyClient, type StubCall } from './helpers/stub-client.js';
import { installToolErrorBoundary } from '../src/tools/annotations.js';
import { registerPlaybackTools } from '../src/tools/playback.js';
import { matchDevice, loadExhaust2Store, saveExhaust2Store } from '../src/playbackstores.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const device = (over: Partial<Record<string, unknown>> & { id: string | null; name: string }) => ({
  type: 'Speaker',
  volume_percent: 30,
  supports_volume: true,
  is_active: false,
  is_restricted: false,
  is_private_session: false,
  ...over,
});

const DEVICES = {
  devices: [
    device({ id: 'dev_desk', name: 'Desk Computer', type: 'Computer', volume_percent: 20 }),
    device({ id: 'dev_phone', name: 'Phone', type: 'Smartphone', volume_percent: 80 }),
    device({ id: null, name: 'Kitchen Remote', volume_percent: null }),
  ],
};

const PLAYER = {
  is_playing: true,
  progress_ms: 30_000,
  shuffle_state: true,
  repeat_state: 'track',
  device: device({ id: 'dev_desk', name: 'Desk Computer', is_active: true, volume_percent: 55 }),
  item: { uri: 'spotify:track:t01', name: 'First', type: 'track', duration_ms: 200_000 },
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

interface Harness {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  text: (r: ToolResult) => string;
  sc: (r: ToolResult) => Record<string, unknown>;
  puts: () => StubCall[];
  calls: () => StubCall[];
}

const open: Array<() => Promise<void>> = [];

/**
 * Register ONLY the two survivors, behind the real boundary, and drive them
 * through a linked in-memory transport pair. The transport is the real MCP
 * client path, so argument validation, the retired-forward rewrite and the
 * deprecation stamp all run exactly as they do in a session.
 */
async function makeHarness(opts: { failPut?: string[]; devices?: unknown; player?: unknown } = {}): Promise<Harness> {
  const client = new StubSpotifyClient();
  client.get_('/me/player', { respond: () => (opts.player === undefined ? PLAYER : opts.player) });
  client.get_('/me/player/devices', { respond: () => (opts.devices === undefined ? DEVICES : opts.devices) });
  const fail = opts.failPut ?? [];
  // Registered most-recent-first, so the generic player route is added last and
  // stays the fallback. The strict stub throws on an unexpected path, which is
  // what turns an unanticipated write into a test failure.
  for (const p of ['/me/player/volume', '/me/player/repeat', '/me/player/shuffle', '/me/player/seek', '/me/player/play']) {
    client.put_(new RegExp(`^${p}(\\?|$)`), {
      respond: (call: StubCall) => {
        if (fail.some((frag) => call.path.startsWith(frag))) {
          throw new Error(`stubbed rejection for PUT ${call.path}`);
        }
        return undefined;
      },
    });
  }
  client.put_('/me/player', {
    respond: (call: StubCall) => {
      if (fail.includes(call.path)) throw new Error(`stubbed rejection for PUT ${call.path}`);
      return undefined;
    },
  });

  const server = new McpServer({ name: 'collapse', version: '0.0.0' });
  registerPlaybackTools(server, client);
  installToolErrorBoundary(server);

  const mcp = new Client({ name: 'collapse-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  open.push(async () => {
    await mcp.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });

  return {
    call: async (name, args = {}) => (await mcp.callTool({ name, arguments: args })) as ToolResult,
    text: (r) => r.content.map((c) => c.text).join('\n'),
    sc: (r) => r.structuredContent ?? {},
    puts: () => client.calls.filter((c) => c.method === 'PUT'),
    calls: () => client.calls,
  };
}

// ---------------------------------------------------------------------------
// Sidecar isolation
// ---------------------------------------------------------------------------

let dir: string;
let prevExt: string | undefined;
let prevExhaust: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'collapse848-'));
  prevExt = process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE;
  prevExhaust = process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE;
  process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = join(dir, 'playback-ext.json');
  process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE = join(dir, 'exhaust2.json');
});

afterEach(async () => {
  while (open.length > 0) await open.pop()!();
  if (prevExt === undefined) delete process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE;
  else process.env.SPOTIFY_MCP_PLAYBACKEXT_FILE = prevExt;
  if (prevExhaust === undefined) delete process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE;
  else process.env.SPOTIFY_MCP_EXHAUST2_PLAYBACK_FILE = prevExhaust;
  await rm(dir, { recursive: true, force: true });
});

const writeStore = (name: string, value: unknown) => writeFile(join(dir, name), JSON.stringify(value, null, 2));

const h_text = (r: ToolResult) => r.content.map((c) => c.text).join('\n');

// ===========================================================================
// 1. The resolver's precedence
// ===========================================================================

describe('#848 the one device resolver', () => {
  // Each step is asserted SEPARATELY. A single test that resolves a label would
  // pass even if the id step or the substring step were gone, and a resolver
  // that quietly reordered its precedence is exactly the drift #848 found in
  // the three copies it replaced.
  it('resolves an exact id, and only an exact id', () => {
    const found = matchDevice(DEVICES.devices, 'dev_phone');
    assert.equal(found?.id, 'dev_phone');
    // A PREFIX of an id is not an id. Matching it would make a truncated id a
    // valid way to name a device, which is a silent wrong-speaker bug.
    assert.equal(matchDevice(DEVICES.devices, 'dev_ph'), null);
  });

  it('matches the id step EXACTLY, and leaves case-folding to the name step', () => {
    // The id step is `d.id === hint`, not a case-insensitive compare. Every
    // other step in the precedence folds case, so this is the one place a
    // reader would assume the same — and it is the step where assuming wrong is
    // worst: an id that differs only in case is not the id step's business, and
    // a resolver that folded it here would claim a match the later, looser
    // steps were supposed to earn.
    //
    // `DEV_PHONE` finds nothing, and specifically not `dev_phone` by the id
    // step. The name step would not rescue it either — no device is *named*
    // `dev_phone` in the fixture — so a fold introduced at the id step shows up
    // as a spurious match rather than as a pass.
    assert.equal(matchDevice(DEVICES.devices, 'DEV_PHONE'), null);
    // The same hint, lower-cased, resolves — proving the fixture and the id
    // step are both live, so the null above is the id step declining and not a
    // dead assertion.
    assert.equal(matchDevice(DEVICES.devices, 'dev_phone')?.id, 'dev_phone');
  });

  it('falls back to the sidecar label, case-insensitively, before the name', async () => {
    await writeStore('playback-ext.json', {
      states: {}, sessions: {}, smartRules: {},
      // "Earphones" is a LABEL. The device is called "Phone", so a name-first
      // resolver would have matched nothing here and a name-substring resolver
      // would have matched "phone" — the two orders disagree on this input,
      // which is what makes the precedence worth pinning.
      devicePresets: { dev_phone: { label: 'Earphones', volume: 20 } },
    });

    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'EARPHONES', dry_run: true });
    assert.equal(h.sc(out).device_id, 'dev_phone');
  });

  it('falls back to a case-insensitive name substring when no id and no label match', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'desk', dry_run: true });
    assert.equal(h.sc(out).device_id, 'dev_desk');
  });

  it('refuses with the real device names rather than guessing the first device', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'Car', dry_run: true });
    const sc = h.sc(out);
    assert.equal(sc.ok, false);
    assert.equal(sc.error, 'device_not_found');
    assert.match(h.text(out), /Desk Computer/);
    assert.deepEqual(h.puts(), [], 'an unresolved target must not reach the player endpoint');
  });

  it('names the label step as unreadable rather than reporting a clean no-match', async () => {
    // #839's rule, one level up: a lookup that failed is disclosed, not folded
    // into "there is no such label". The refusal still stands — the other two
    // steps were asked and answered — but the caveat says which step was not.
    await writeFile(join(dir, 'playback-ext.json'), '{not json');
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'Earphones', dry_run: true });
    assert.match(h.text(out), /device-label store could not be read/i);
  });
});

// ===========================================================================
// 2. The ten forwards
// ===========================================================================

describe('#848 retired names forward with the flags that made them themselves', () => {
  /**
   * The issue's acceptance criteria name `handoff` and `apply_device_presets`
   * explicitly. Both are here, and so is the rest — a table is only worth having
   * if a row added without a test fails, so every row drives a real call.
   */
  it('handoff forwards to transfer_playback with preserve_position', async () => {
    const h = await makeHarness();
    const out = await h.call('handoff', { device_id: 'dev_phone', response_format: 'json' });
    const sc = h.sc(out);
    assert.deepEqual(sc.deprecated_inputs, ['handoff']);
    assert.match(String(sc.deprecation_note), /transfer_playback/);
    assert.match(String(sc.deprecation_note), /preserve_position/);
    // The forwarding is the CLAIM: a resume at the captured offset is what
    // `handoff` promised, and a preserve-less transfer would not make one.
    assert.deepEqual(h.puts().map((p) => p.path), [
      '/me/player',
      '/me/player/play?device_id=dev_phone',
    ]);
    assert.equal((h.puts()[1]?.arg as { position_ms: number }).position_ms, 30_000);
    // `handoff` was a preserve transfer, so the transfer body must NOT force
    // play: forcing it restarts the track the resume is about to seek into.
    assert.deepEqual(h.puts()[0]?.arg, { device_ids: ['dev_phone'] });
  });

  it('handoff NEVER lets `play` force a restart, in either direction', async () => {
    // A perturbation of the forwarding table dropped `play` from `handoff`'s
    // rewrite and NOTHING went red — which is correct, and worth pinning as
    // fact rather than left as an accident. `handoff` forwards
    // `preserve_position: true` unconditionally, and that flag makes the
    // arrival clause "resume at the captured position" in every case, so an
    // explicit `play` has no observable effect left to lose: the transfer body
    // omits `play` (sending it would restart the track the resume seeks into),
    // the resume is issued from the captured state either way, and the step
    // text is the same. A caller passing `play` to `handoff` gets the handoff
    // it asked for; the flag is inert, not dropped.
    for (const play of [true, false] as const) {
      const h = await makeHarness();
      const out = await h.call('handoff', { device_id: 'dev_phone', play, response_format: 'json' });
      const paths = h.puts().map((p) => p.path);
      assert.deepEqual(h.puts()[0]?.arg, { device_ids: ['dev_phone'] },
        `play=${play} must not reach the transfer body in preserve mode`);
      assert.ok(paths.includes('/me/player/play?device_id=dev_phone'),
        `play=${play} still resumes from the captured position`);
      assert.equal(h.sc(out).device_id, 'dev_phone');
    }
  });

  it('apply_device_presets forwards to set_volume with op: preset', async () => {
    await writeStore('playback-ext.json', {
      states: {}, sessions: {}, smartRules: {},
      devicePresets: { dev_phone: { label: 'Phone', volume: 42 } },
    });

    const h = await makeHarness();
    const out = await h.call('apply_device_presets', {});
    const sc = h.sc(out);
    assert.deepEqual(sc.deprecated_inputs, ['apply_device_presets']);
    assert.match(String(sc.deprecation_note), /op: preset/);
    assert.match(h.text(out), /Applied 1\/1 volume presets/);
    // #830: the surviving write must send `volume_percent=`, not `volume=`. A
    // forward that lost the parameter name would 400 at Spotify and the tool
    // would still report success for a preset it never applied.
    assert.deepEqual(h.puts().map((p) => p.path), ['/me/player/volume?volume_percent=42&device_id=dev_phone']);
  });

  it('switch_device forwards to transfer_playback, defaulting play to true', async () => {
    const h = await makeHarness();
    const out = await h.call('switch_device', { device_name: 'desk', response_format: 'json' });
    assert.deepEqual(h.sc(out).deprecated_inputs, ['switch_device']);
    assert.deepEqual(h.puts()[0]?.arg, { device_ids: ['dev_desk'], play: true });
  });

  it('transfer_playback_with_state forwards to the full-state transfer', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback_with_state', { target_device: 'dev_desk', response_format: 'json' });
    assert.deepEqual(h.sc(out).deprecated_inputs, ['transfer_playback_with_state']);
    // The full-state contract: transfer, resume, seek, then put the modes back.
    assert.deepEqual(h.puts().map((p) => p.path), [
      '/me/player',
      '/me/player/play?device_id=dev_desk',
      '/me/player/seek?position_ms=30000&device_id=dev_desk',
      '/me/player/shuffle?state=true&device_id=dev_desk',
      '/me/player/repeat?state=track&device_id=dev_desk',
    ]);
  });

  it('mute and unmute forward to the op that remembers the level', async () => {
    const muted = await makeHarness();
    const m = await muted.call('mute', {});
    assert.match(muted.text(m), /Muted Desk Computer \(was 55% — remembered for unmute\)/);
    // The level to restore is the level that was actually dropped, not a
    // default: a mute that stored 0 would be an unmute that restored silence.
    assert.equal((await loadExhaust2Store()).muteMemory.dev_desk?.volume, 55);

    const un = await makeHarness();
    const u = await un.call('unmute', { device_id: 'dev_desk', response_format: 'json' });
    assert.deepEqual(un.sc(u).deprecated_inputs, ['unmute']);
    assert.deepEqual(un.puts().map((p) => p.path), ['/me/player/volume?volume_percent=55&device_id=dev_desk']);
  });

  it('volume_step forwards to delta_step and clamps at 0', async () => {
    const h = await makeHarness({ player: { ...PLAYER, device: { ...PLAYER.device, volume_percent: 10 } } });
    const out = await h.call('volume_step', { step: -80, response_format: 'json' });
    assert.deepEqual(h.sc(out).deprecated_inputs, ['volume_step']);
    assert.deepEqual(h.puts().map((p) => p.path), ['/me/player/volume?volume_percent=0&device_id=dev_desk']);
  });

  it('room_level forwards to the copy-the-active-level variant, honouring the exclusion', async () => {
    const h = await makeHarness({
      devices: {
        devices: [
          device({ id: 'dev_desk', name: 'Desk Computer', is_active: true, volume_percent: 50 }),
          device({ id: 'dev_phone', name: 'Phone', type: 'Smartphone' }),
        ],
      },
    });
    const out = await h.call('room_level', { exclude_device_id: 'dev_phone', response_format: 'json' });
    assert.deepEqual(h.sc(out).deprecated_inputs, ['room_level']);
    assert.deepEqual(h.puts(), [], 'the only other live device was excluded');
  });

  it('apply_volume_plan forwards to a fan-out over every volume-capable device', async () => {
    const h = await makeHarness();
    const out = await h.call('apply_volume_plan', { volume: 25 });
    assert.match(h.text(out), /apply_volume_plan is deprecated/);
    // An omitted selection meant "every volume-capable device", so the forward
    // must set `all_devices`. Without it the single-device branch would write
    // the active device only and report success for the two it skipped.
    assert.deepEqual(h.puts().map((p) => p.path).sort(), [
      '/me/player/volume?volume_percent=25&device_id=dev_desk',
      '/me/player/volume?volume_percent=25&device_id=dev_phone',
    ]);
    assert.match(h.text(out), /skipped 1 volume-capable device with no device id/);
  });

  it('plan_volume_level_across_devices forwards to a dry run even when the caller asks to commit', async () => {
    // The one forward that OVERRIDES an argument. A read-only planner must not
    // become a writer on its way out, so `dry_run: true` is forced last.
    const h = await makeHarness();
    const out = await h.call('plan_volume_level_across_devices', { volume: 55, dry_run: false });
    const sc = h.sc(out);
    assert.deepEqual(sc.deprecated_inputs, ['plan_volume_level_across_devices']);
    assert.equal(sc.dry_run, true);
    assert.deepEqual(sc.devices, ['dev_desk', 'dev_phone']);
    assert.deepEqual(h.puts(), [], 'a forwarded planner must not write');
  });

  it('every retired name names itself in deprecated_inputs and the survivor in prose', async () => {
    // The note has to be on the TEXT as well as the structured payload: a host
    // reading prose is the case a deprecation exists for, and both survivors
    // return MUTATION_EMIT, which drops structuredContent outside json mode.
    // Each name is called with the argument that name used to take, so the
    // forward has something to translate. `{}` would be a different test: it
    // would prove the name resolves, not that its arguments survive.
    const argsFor: Record<string, Record<string, unknown>> = {
      mute: { device_id: 'dev_desk' },
      unmute: { device_id: 'dev_desk' },
      volume_step: { step: 5 },
      room_level: {},
      apply_device_presets: {},
      apply_volume_plan: { volume: 25 },
      plan_volume_level_across_devices: { volume: 25 },
      switch_device: { device_name: 'dev_desk' },
      handoff: { device_id: 'dev_desk' },
      transfer_playback_with_state: { target_device: 'dev_desk' },
    };
    for (const [name, args] of Object.entries(argsFor)) {
      const h = await makeHarness();
      const out = await h.call(name, args);
      const text = h.text(out);
      assert.match(text, new RegExp(`${name} is deprecated`), `${name} must disclose the deprecation in prose`);
      assert.match(text, /transfer_playback|set_volume/, `${name} must name the survivor in prose`);
      assert.match(text, /v3\.0/, `${name} must say when the name stops being callable`);
    }
  });
});

// ===========================================================================
// 3. The deprecated input alias
// ===========================================================================

describe('#848 the device_id -> device input fold', () => {
  it('accepts device_id and names the canonical input in the notice', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device_id: 'dev_phone', response_format: 'json' });
    const sc = h.sc(out);
    assert.deepEqual(sc.deprecated_inputs, ['device_id']);
    assert.match(String(sc.deprecation_note), /device_id → device/);
    assert.match(String(sc.deprecation_note), /v2\.2/);
    assert.equal(sc.device_id, 'dev_phone');
    assert.deepEqual(h.puts()[0]?.arg, { device_ids: ['dev_phone'] });
  });

  it('lets the canonical name win when both are sent, and still reports the stale one', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'dev_phone', device_id: 'dev_desk', response_format: 'json' });
    assert.deepEqual(h.puts()[0]?.arg, { device_ids: ['dev_phone'] }, 'the canonical name is the one that was read');
    assert.deepEqual(h.sc(out).deprecated_inputs, ['device_id']);
  });

  it('folds BEFORE validation, so a deprecated-only call is not refused for a missing device', async () => {
    // The ordering is the whole point: the boundary normalises first, so the
    // handler never sees a `device_id`, and the published schema still spends
    // zero bytes on a key that only exists for one more release.
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device_id: 'dev_phone', dry_run: true });
    assert.notEqual(out.isError, true, h.text(out));
    assert.equal(h.sc(out).device_id, 'dev_phone');
  });
});

// ===========================================================================
// 4. set_volume's refusals
// ===========================================================================

describe('#848 set_volume refuses a contradictory request before it spends a request', () => {
  it('refuses volume_percent together with delta_step, naming both', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { volume_percent: 40, delta_step: 10 });
    const sc = h.sc(out);
    assert.equal(sc.error, 'conflicting_inputs');
    assert.deepEqual(sc.fields, ['volume_percent', 'delta_step']);
    assert.deepEqual(h.calls(), [], 'the refusal happens before any Spotify call');
  });

  it('refuses a field that means nothing for the requested op, and names it', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { op: 'mute', volume_percent: 40 });
    const sc = h.sc(out);
    assert.equal(sc.error, 'unsupported_for_op');
    assert.deepEqual(sc.fields, ['volume_percent']);
    assert.match(h.text(out), /no meaning here/);
    assert.deepEqual(h.calls(), []);
  });

  it('refuses device_ids without a level, rather than defaulting one', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { op: 'level', device_ids: ['dev_phone'] });
    const sc = h.sc(out);
    assert.equal(sc.error, 'missing_input');
    assert.deepEqual(sc.fields, ['volume_percent']);
    assert.deepEqual(h.calls(), []);
  });

  it('refuses device_ids together with all_devices, naming both', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { volume_percent: 30, device_ids: ['dev_phone'], all_devices: true });
    const sc = h.sc(out);
    assert.equal(sc.error, 'conflicting_inputs');
    assert.deepEqual(sc.fields, ['device_ids', 'all_devices']);
    assert.deepEqual(h.calls(), []);
  });

  it('refuses exclude_device_id alongside an explicit level', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { op: 'level', volume_percent: 30, exclude_device_id: 'dev_phone' });
    assert.equal(h.sc(out).error, 'conflicting_inputs');
    assert.deepEqual(h.calls(), []);
  });

  it('refuses an empty request rather than reporting a volume it did not set', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', {});
    const sc = h.sc(out);
    assert.equal(sc.ok, false);
    assert.equal(sc.error, 'missing_input');
    assert.deepEqual(sc.fields, ['volume_percent', 'delta_step']);
    assert.deepEqual(h.calls(), []);
  });
});

// ===========================================================================
// 5. Behaviour that moved modules
// ===========================================================================

describe('#848 behaviour that moved into the survivors', () => {
  it('mute remembers the level, and a REJECTED write remembers nothing (#843)', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { op: 'mute' });
    assert.match(h.text(out), /was 55%/);
    assert.equal((await loadExhaust2Store()).muteMemory.dev_desk?.volume, 55);

    await saveExhaust2Store({ muteMemory: {}, episodeBookmarks: {}, checkpoints: {} });

    const rejected = await makeHarness({ failPut: ['/me/player/volume'] });
    // The boundary turns a handler throw into an error RESULT, so this is an
    // assertion about what was written, not about how the failure surfaced.
    const failed = await rejected.call('set_volume', { op: 'mute' });
    assert.equal(failed.isError, true, h_text(failed));
    assert.deepEqual(
      (await loadExhaust2Store()).muteMemory,
      {},
      'a level that was never actually dropped must not be restorable',
    );
  });

  it('unmute with no memory falls back to 50% and says that is what it did', async () => {
    const h = await makeHarness();
    const out = await h.call('set_volume', { op: 'unmute' });
    assert.match(h.text(out), /no memory — default 50%/);
    // No `device_id`, because there is no memory to name a device from. The
    // write goes to whichever device Spotify considers active, which is what
    // `unmute` did with no memory too; adding the active device's id here
    // would be a claim about a device this call never resolved.
    assert.deepEqual(h.puts().map((p) => p.path), ['/me/player/volume?volume_percent=50']);
  });

  it('a preset that Spotify refuses is listed as failed, not counted as applied', async () => {
    // #803's rule in the shape #848 created: a write that did not land must be
    // named, because "Applied 1/1" beside a 400 tells the reader their speaker
    // is at 42% when it is still at 20%.
    await writeStore('playback-ext.json', {
      states: {}, sessions: {}, smartRules: {},
      devicePresets: { dev_phone: { label: 'Phone', volume: 42 } },
    });
    const h = await makeHarness({ failPut: ['/me/player/volume'] });
    const out = await h.call('set_volume', { op: 'preset' });
    const sc = h.sc(out);
    assert.equal(sc.applied, 0);
    assert.deepEqual(sc.failed, ['dev_phone']);
    assert.equal(sc.ok, false);
  });

  it('room-level copies the active device to every other live device', async () => {
    const h = await makeHarness({
      devices: {
        devices: [
          device({ id: 'dev_desk', name: 'Desk Computer', is_active: true, volume_percent: 50 }),
          device({ id: 'dev_phone', name: 'Phone', type: 'Smartphone' }),
          device({ id: 'dev_tv', name: 'TV', type: 'TV', is_restricted: true, volume_percent: null }),
        ],
      },
    });
    const out = await h.call('set_volume', { op: 'level' });
    assert.match(h.text(out), /Room levelled: 1\/1/);
    assert.deepEqual(h.puts().map((p) => p.path), ['/me/player/volume?volume_percent=50&device_id=dev_phone']);
  });

  it('a full-state transfer names the step that failed instead of claiming a clean move', async () => {
    // play:false takes the seek branch, so the stubbed failure lands on `seek`.
    const h = await makeHarness({ failPut: ['/me/player/seek'] });
    const out = await h.call('transfer_playback', { device: 'dev_desk', play: false, restore_shuffle_repeat: true, response_format: 'json' });
    const sc = h.sc(out);
    assert.equal(sc.transferred, false);
    assert.deepEqual(sc.failed_steps, ['seek']);
    // Prose mode carries the same disclosure in a sentence, because the failed
    // step is the difference between "moved" and "moved, except the position".
    const prose = await (await makeHarness({ failPut: ['/me/player/seek'] }))
      .call('transfer_playback', { device: 'dev_desk', play: false, restore_shuffle_repeat: true });
    assert.match(h_text(prose), /failed steps: seek/);
  });

  it('a full-state transfer falls back to a seek when the resume is refused', async () => {
    const h = await makeHarness({ failPut: ['/me/player/play'] });
    const out = await h.call('transfer_playback', { device: 'dev_desk', restore_shuffle_repeat: true, response_format: 'json' });
    const sc = h.sc(out);
    assert.equal(sc.transferred, true, 'the seek fallback is a success, not a partial failure');
    assert.deepEqual(h.puts().map((p) => p.path), [
      '/me/player',
      '/me/player/play?device_id=dev_desk',
      '/me/player/seek?position_ms=30000&device_id=dev_desk',
      '/me/player/shuffle?state=true&device_id=dev_desk',
      '/me/player/repeat?state=track&device_id=dev_desk',
    ]);
  });

  it('restore_shuffle_repeat never writes two question marks into one query (#668)', async () => {
    const h = await makeHarness();
    await h.call('transfer_playback', { device: 'dev_desk', restore_shuffle_repeat: true });
    for (const p of h.puts()) {
      assert.doesNotMatch(p.path, /\?[^?]*\?/, `"${p.path}" has two '?' — the second parameter is part of the first value`);
    }
  });

  it('a bare transfer does not read the player, so it cannot claim the session was paused', async () => {
    // The plan's step text used to append "(paused)" for a transfer that never
    // fetched `/me/player` — a claim about a value nobody looked up.
    //
    // Run against a PAUSED fixture on purpose. With a playing one the claim
    // does not fire either way, so the assertion would pass against the very
    // bug it is written for; the perturbed source (the capture flag forced on)
    // is indistinguishable from the real one unless something was playing to
    // be paused.
    const PAUSED_SUFFIX = /\(the captured session was paused\)/;
    const paused = await makeHarness({ player: { ...PLAYER, is_playing: false } });
    const out = await paused.call('transfer_playback', { device: 'dev_desk', dry_run: true });
    assert.doesNotMatch(paused.text(out), PAUSED_SUFFIX);
    assert.equal(paused.calls().filter((c) => c.path === '/me/player').length, 0);

    // And with a state READ, the same claim is made — which is what makes the
    // first half a claim about reading rather than a claim about wording.
    const preserving = await makeHarness({ player: { ...PLAYER, is_playing: false, progress_ms: 0 } });
    const p = await preserving.call('transfer_playback', { device: 'dev_desk', dry_run: true, preserve_position: true });
    assert.match(preserving.text(p), /\(the captured session was paused\)/);
  });

  it('an unresolved full-state target issues no write at all', async () => {
    const h = await makeHarness();
    const out = await h.call('transfer_playback', { device: 'Car', restore_shuffle_repeat: true });
    assert.equal(h.sc(out).ok, false);
    assert.deepEqual(h.puts(), []);
  });
});
