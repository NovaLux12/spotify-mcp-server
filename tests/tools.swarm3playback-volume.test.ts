/**
 * Volume-plan device selection in swarm3_playback (#853).
 *
 * `apply_volume_plan` / `plan_volume_level_across_devices` used to select on
 * `supports_volume` alone, so a device reported by Spotify without an id
 * produced `device_id=` with an empty value (wrong device / 400) and the plan
 * text printed that empty id for an agent to copy by hand.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SpotifyClient } from '../src/client.js';
import { registerSwarm3PlaybackTools } from '../src/tools/swarm3_playback.js';

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Registered = {
  name: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
};

interface DeviceStub {
  id: string | null;
  name: string;
  type: string;
  volume_percent: number | null;
  supports_volume: boolean;
  is_active: boolean;
  is_restricted: boolean;
  is_private_session: boolean;
}

function device(over: Partial<DeviceStub> & { id: string | null; name: string }): DeviceStub {
  return {
    type: 'Speaker',
    volume_percent: 30,
    supports_volume: true,
    is_active: false,
    is_restricted: false,
    is_private_session: false,
    ...over,
  };
}

interface Harness {
  find: (name: string) => Registered;
  invoke: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  calls: Array<{ method: string; path: string; arg?: unknown }>;
  text: (r: ToolResult) => string;
  structured: (r: ToolResult) => Record<string, unknown>;
}

function makeHarness(devices: DeviceStub[]): Harness {
  const registered: Registered[] = [];
  const calls: Array<{ method: string; path: string; arg?: unknown }> = [];
  const server = {
    tool(name: string, _desc: string, schema: z.ZodRawShape, handler: Registered['handler']) {
      registered.push({ name, schema, handler });
    },
  } as unknown as McpServer;
  const client = {
    calls,
    async get<T>(path: string): Promise<T | null> {
      calls.push({ method: 'GET', path });
      if (path === '/me/player/devices') return { devices } as unknown as T;
      throw new Error(`unexpected GET ${path}`);
    },
    async put<T>(path: string, body?: unknown): Promise<T | null> {
      calls.push({ method: 'PUT', path, arg: body });
      return null as unknown as T;
    },
  } as unknown as SpotifyClient;
  registerSwarm3PlaybackTools(server, client);
  const find = (name: string) => {
    const t = registered.find((x) => x.name === name);
    assert.ok(t, `tool ${name} must be registered`);
    return t;
  };
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const t = find(name);
    return t.handler(z.object(t.schema).parse(args) as Record<string, unknown>);
  };
  return {
    find,
    invoke,
    calls,
    text: (r: ToolResult) => r.content[0].text,
    structured: (r: ToolResult) => r.structuredContent as Record<string, unknown>,
  };
}


describe('volume plan device selection (#853)', () => {
  // Spotify reports some devices (remotes, restricted sessions) with id: null.
  const MIXED: DeviceStub[] = [
    device({ id: null, name: 'Kitchen Remote', volume_percent: null }),
    device({ id: 'dev_real', name: 'Kitchen Speaker', is_active: true }),
    device({ id: 'dev_phone', name: 'Phone', type: 'Smartphone', volume_percent: 80 }),
  ];

  it('apply_volume_plan skips the id-less device and names a real id in the preview', async () => {
    const h = makeHarness(MIXED);
    const out = await h.invoke('apply_volume_plan', { volume: 42 });
    const sc = h.structured(out);

    assert.equal(h.calls.filter((c) => c.method === 'PUT').length, 0, 'dry_run must not PUT');

    const steps = sc.steps as string[];
    assert.equal(steps.length, 2, 'id-less device must not be selected');
    for (const step of steps) {
      assert.match(step, /device dev_(real|phone)/, `preview must name a real device id: ${step}`);
    }
    assert.doesNotMatch(h.text(out), /device_id=(?:[^\s")]*)(?=["\s)])/, 'no empty device_id in the plan');
    assert.doesNotMatch(h.text(out), /\(device (null|undefined)\)/, 'no undefined device id in the plan');
    // The id-less device is reported, not silently dropped.
    assert.equal(sc.skipped_no_id, 1);
    assert.match(h.text(out), /skipped 1 volume-capable device/);
  });

  it('apply_volume_plan dry_run=false never PUTs to the id-less device', async () => {
    const h = makeHarness(MIXED);
    await h.invoke('apply_volume_plan', { volume: 30, dry_run: false });
    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2, 'one PUT per selectable device only');
    for (const p of puts) {
      assert.match(p.path, /device_id=dev_(real|phone)$/, `PUT must carry a real id: ${p.path}`);
    }
  });

  it('plan_volume_level_across_devices skips the id-less device too', async () => {
    const h = makeHarness(MIXED);
    const out = await h.invoke('plan_volume_level_across_devices', { volume: 55 });
    const sc = h.structured(out);
    assert.deepEqual(sc.devices, ['dev_real', 'dev_phone']);
    assert.equal(sc.skipped_no_id, 1);
  });

  // #830: the plan is the request an agent copies, so it must name the query
  // parameters the wire call really sends (`volume_percent`, `device_id`) —
  // not the tool's own input name (`volume`).
  it('plan text names exactly the parameters the real PUT sends', async () => {
    const h = makeHarness(MIXED);
    for (const tool of ['apply_volume_plan', 'plan_volume_level_across_devices']) {
      const out = await h.invoke(tool, { volume: 42 });
      const steps = (h.structured(out).steps as string[]) ?? [];
      assert.ok(steps.length > 0, `${tool} must produce plan steps`);
      for (const step of steps) {
        assert.match(step, /volume_percent=42\b/, `${tool} plan must print the real query param: ${step}`);
        assert.doesNotMatch(step, /[^_]\bvolume=/, `${tool} plan must not print the rejected \`volume\` spelling: ${step}`);
        const [, param] = step.match(/([A-Za-z_][A-Za-z0-9_]*)=/)!;
        assert.equal(param, 'volume_percent');
      }
    }
  });

  it('apply_volume_plan PUTs volume_percent per selected device', async () => {
    const h = makeHarness(MIXED);
    await h.invoke('apply_volume_plan', { volume: 42, dry_run: false });
    const puts = h.calls.filter((c) => c.method === 'PUT');
    assert.equal(puts.length, 2, 'one PUT per selectable device only');
    const seen = puts.map((p) => {
      const qs = new URLSearchParams(p.path.split('?')[1]);
      assert.equal(qs.get('volume'), null, `Spotify does not accept \`volume\`: ${p.path}`);
      return [qs.get('device_id'), qs.get('volume_percent')] as const;
    });
    assert.deepEqual(seen.sort(), [['dev_phone', '42'], ['dev_real', '42']]);
  });

  it('reports the skip when every volume-capable device lacks an id', async () => {
    const h = makeHarness([device({ id: null, name: 'Remote A' }), device({ id: null, name: 'Remote B' })]);
    const out = await h.invoke('apply_volume_plan', { volume: 10 });
    const sc = h.structured(out);
    assert.deepEqual(sc.steps, []);
    assert.equal(sc.skipped_no_id, 2);
    assert.match(h.text(out), /skipped 2 volume-capable devices/);
  });
});
